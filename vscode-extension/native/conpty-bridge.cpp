// conpty-bridge: runs a command inside a Windows pseudo console (ConPTY) and talks to its parent over stdin/stdout.
//
//   conpty-bridge.exe <columns> <rows> <working directory> <command line>
//
// Everything on stdin and stdout is a sequence of frames:  [type: 1 byte][length: 4 bytes, little endian][payload]
//
//   parent -> bridge   1 INPUT   bytes for the terminal input (what the user types, as UTF-8 / VT sequences)
//                      2 RESIZE  u16 columns, u16 rows
//                      3 CLEAR   u8 1: keep the row of the cursor (the terminal cleared its screen, the pseudo console forgets it too)
//   bridge -> parent   1 OUTPUT  bytes the program wrote (UTF-8 / VT sequences)
//                      2 EXIT    u32 exit code of the command
//                      3 PROCS   names of the programs running under the command, lower case, one per line
//                      4 READY   u32 process id of the command
//                      5 ERROR   message text
//
// When the parent closes the pipe, the pseudo console is closed, which ends the command and everything it started.
// Set the environment variable OC_BRIDGE_TRACE to see what the bridge does on its standard error.
// OC_CONPTY_FLAGS (a decimal number) replaces the flags of CreatePseudoConsole, to try the others (the default is 0).
//
// Build: native\build.ps1   (static runtime, no DLLs needed besides the ones of Windows)

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace
{
    enum : uint8_t
    {
        FromParentInput = 1,
        FromParentResize = 2,
        FromParentClear = 3,
        ToParentOutput = 1,
        ToParentExit = 2,
        ToParentProcs = 3,
        ToParentReady = 4,
        ToParentError = 5,
    };

    // The pseudo console functions: the ones of Windows, or (when the parent names it in OC_CONPTY_DLL) the ones of the conpty.dll
    // that VS Code ships for its own terminal. That one comes with its own OpenConsole.exe, and it can also clear the pseudo console.
    using CreatePtyFn = HRESULT(WINAPI*)(COORD, HANDLE, HANDLE, DWORD, HPCON*);
    using ResizePtyFn = HRESULT(WINAPI*)(HPCON, COORD);
    using ClosePtyFn = void(WINAPI*)(HPCON);
    using ClearPtyFn = HRESULT(WINAPI*)(HPCON, BOOL);
    CreatePtyFn g_createPty = &CreatePseudoConsole;
    ResizePtyFn g_resizePty = &ResizePseudoConsole;
    ClosePtyFn g_closePty = &ClosePseudoConsole;
    ClearPtyFn g_clearPty = nullptr;

    HANDLE g_stdout = INVALID_HANDLE_VALUE;
    std::mutex g_writeLock;
    std::mutex g_consoleLock; // guards the pseudo console handle, which is closed by whichever thread notices the end first
    bool g_trace = false;
    std::atomic<ULONGLONG> g_lastOutputTick{ 0 };

    void Trace(const std::string& what)
    {
        if (g_trace)
        {
            const std::string line = "[bridge] " + what + "\n";
            DWORD written = 0;
            WriteFile(GetStdHandle(STD_ERROR_HANDLE), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
        }
    }

    // A frame is written with a single call, so that the header and the payload can never be torn apart.
    void SendFrame(uint8_t type, const void* data, uint32_t length)
    {
        std::vector<uint8_t> frame(5 + static_cast<size_t>(length));
        frame[0] = type;
        std::memcpy(frame.data() + 1, &length, 4);
        if (length)
        {
            std::memcpy(frame.data() + 5, data, length);
        }
        std::lock_guard<std::mutex> lock(g_writeLock);
        const uint8_t* p = frame.data();
        size_t left = frame.size();
        while (left > 0)
        {
            const DWORD chunk = left > (1u << 20) ? (1u << 20) : static_cast<DWORD>(left);
            DWORD written = 0;
            if (!WriteFile(g_stdout, p, chunk, &written, nullptr) || written == 0)
            {
                Trace("cannot write to the parent, error " + std::to_string(GetLastError()));
                return;
            }
            p += written;
            left -= written;
        }
    }

    void SendError(const std::string& message)
    {
        SendFrame(ToParentError, message.data(), static_cast<uint32_t>(message.size()));
    }

    bool ReadExact(HANDLE h, void* buffer, DWORD size)
    {
        auto* p = static_cast<uint8_t*>(buffer);
        while (size > 0)
        {
            DWORD got = 0;
            if (!ReadFile(h, p, size, &got, nullptr) || got == 0)
            {
                return false;
            }
            p += got;
            size -= got;
        }
        return true;
    }

    std::string ToUtf8(const std::wstring& w)
    {
        if (w.empty())
        {
            return {};
        }
        const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
        std::string s(static_cast<size_t>(n), '\0');
        WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
        return s;
    }

    void UseSystemConPty()
    {
        g_createPty = &CreatePseudoConsole;
        g_resizePty = &ResizePseudoConsole;
        g_closePty = &ClosePseudoConsole;
        g_clearPty = nullptr;
    }

    // Loads the conpty.dll that OC_CONPTY_DLL names. Returns false, and keeps the functions of Windows, when there is none or when
    // it cannot be used.
    bool UseSideloadedConPty()
    {
        wchar_t path[2048];
        const DWORD n = GetEnvironmentVariableW(L"OC_CONPTY_DLL", path, ARRAYSIZE(path));
        SetEnvironmentVariableW(L"OC_CONPTY_DLL", nullptr);      // the shell has no use for it
        if (n == 0 || n >= ARRAYSIZE(path))
        {
            return false;
        }
        const HMODULE dll = LoadLibraryExW(path, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
        if (!dll)
        {
            Trace("cannot load " + ToUtf8(path) + ", error " + std::to_string(GetLastError()));
            return false;
        }
        const auto create = reinterpret_cast<CreatePtyFn>(GetProcAddress(dll, "CreatePseudoConsole"));
        const auto resize = reinterpret_cast<ResizePtyFn>(GetProcAddress(dll, "ResizePseudoConsole"));
        const auto close = reinterpret_cast<ClosePtyFn>(GetProcAddress(dll, "ClosePseudoConsole"));
        const auto clear = reinterpret_cast<ClearPtyFn>(GetProcAddress(dll, "ClearPseudoConsole"));
        if (!create || !resize || !close)
        {
            Trace("the functions of the pseudo console are missing in " + ToUtf8(path));
            FreeLibrary(dll);
            return false;
        }
        g_createPty = create;
        g_resizePty = resize;
        g_closePty = close;
        g_clearPty = clear;
        Trace("using the pseudo console of " + ToUtf8(path));
        return true;
    }

    std::wstring Lower(std::wstring s)
    {
        std::transform(s.begin(), s.end(), s.begin(), [](wchar_t c) { return static_cast<wchar_t>(::towlower(c)); });
        return s;
    }

    // Names of the command itself and of all the processes it started (children, grandchildren, ...), sorted.
    std::string RunningProgramNames(DWORD root)
    {
        struct Info
        {
            DWORD parent;
            std::wstring name;
        };
        std::map<DWORD, Info> all;
        const HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID_HANDLE_VALUE)
        {
            return {};
        }
        PROCESSENTRY32W pe{};
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(snap, &pe))
        {
            do
            {
                all[pe.th32ProcessID] = { pe.th32ParentProcessID, pe.szExeFile };
            } while (Process32NextW(snap, &pe));
        }
        CloseHandle(snap);

        std::set<DWORD> members{ root };
        bool grew = true;
        while (grew)
        {
            grew = false;
            for (const auto& [pid, info] : all)
            {
                if (members.count(pid) == 0 && members.count(info.parent) != 0 && pid != info.parent)
                {
                    members.insert(pid);
                    grew = true;
                }
            }
        }
        std::set<std::wstring> names;
        for (const auto pid : members)
        {
            const auto it = all.find(pid);
            if (it != all.end())
            {
                names.insert(Lower(it->second.name));
            }
        }
        std::wstring joined;
        for (const auto& n : names)
        {
            joined += n;
            joined += L'\n';
        }
        return ToUtf8(joined);
    }
}

int wmain(int argc, wchar_t** argv)
{
    g_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    const HANDLE stdinHandle = GetStdHandle(STD_INPUT_HANDLE);
    g_trace = GetEnvironmentVariableW(L"OC_BRIDGE_TRACE", nullptr, 0) > 0;

    if (argc < 5)
    {
        SendError("usage: conpty-bridge <columns> <rows> <working directory> <command line>");
        return 2;
    }
    const auto columns = static_cast<SHORT>(std::max(1, _wtoi(argv[1])));
    const auto rows = static_cast<SHORT>(std::max(1, _wtoi(argv[2])));
    const std::wstring workingDirectory = argv[3];
    std::wstring commandLine = argv[4];

    HANDLE inputRead = nullptr, inputWrite = nullptr, outputRead = nullptr, outputWrite = nullptr;
    if (!CreatePipe(&inputRead, &inputWrite, nullptr, 0) || !CreatePipe(&outputRead, &outputWrite, nullptr, 0))
    {
        SendError("CreatePipe failed");
        return 3;
    }

    HPCON pseudoConsole = nullptr;
    // The flags of CreatePseudoConsole. OC_CONPTY_FLAGS (a decimal number) replaces them, to try the others.
    DWORD flags = 0;
    {
        wchar_t text[16];
        const DWORD n = GetEnvironmentVariableW(L"OC_CONPTY_FLAGS", text, ARRAYSIZE(text));
        if (n > 0 && n < ARRAYSIZE(text)) flags = wcstoul(text, nullptr, 10);
        SetEnvironmentVariableW(L"OC_CONPTY_FLAGS", nullptr);      // the shell has no use for it
    }
    Trace("pseudo console flags: " + std::to_string(flags));
    const bool sideloaded = UseSideloadedConPty();
    HRESULT hr = g_createPty(COORD{ columns, rows }, inputRead, outputWrite, flags, &pseudoConsole);
    if (FAILED(hr) && sideloaded)
    {
        Trace("the pseudo console of the sideloaded conpty.dll failed (0x" + std::to_string(static_cast<unsigned long>(hr)) + "), using the one of Windows");
        UseSystemConPty();
        pseudoConsole = nullptr;
        hr = g_createPty(COORD{ columns, rows }, inputRead, outputWrite, flags, &pseudoConsole);
    }
    if (FAILED(hr))
    {
        SendError("CreatePseudoConsole failed (this needs Windows 10 version 1809 or later)");
        return 4;
    }
    CloseHandle(inputRead);
    CloseHandle(outputWrite);

    SIZE_T attributeListSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeListSize);
    std::vector<uint8_t> attributeStorage(attributeListSize);
    auto* attributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    if (!InitializeProcThreadAttributeList(attributeList, 1, 0, &attributeListSize) ||
        !UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pseudoConsole, sizeof(pseudoConsole), nullptr, nullptr))
    {
        SendError("cannot attach the pseudo console");
        return 5;
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributeList;
    // Our own standard handles are pipes to the parent. Without this the command would write straight into them
    // instead of into the pseudo console (this is what node-pty does as well).
    startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nullptr;
    startup.StartupInfo.hStdOutput = nullptr;
    startup.StartupInfo.hStdError = nullptr;
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, FALSE,
                        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, nullptr,
                        workingDirectory.empty() ? nullptr : workingDirectory.c_str(), &startup.StartupInfo, &process))
    {
        const DWORD error = GetLastError();
        SendError("cannot start the command (error " + std::to_string(error) + "): " + ToUtf8(commandLine));
        return 6;
    }
    CloseHandle(process.hThread);

    const uint32_t pid = process.dwProcessId;
    SendFrame(ToParentReady, &pid, sizeof(pid));

    std::atomic<bool> finished{ false };
    std::atomic<bool> outputDone{ false };

    // program -> parent
    std::thread outputThread([&] {
        std::vector<uint8_t> buffer(64 * 1024);
        for (;;)
        {
            DWORD got = 0;
            if (!ReadFile(outputRead, buffer.data(), static_cast<DWORD>(buffer.size()), &got, nullptr) || got == 0)
            {
                break;
            }
            g_lastOutputTick = GetTickCount64();
            SendFrame(ToParentOutput, buffer.data(), got);
        }
        outputDone = true;
    });

    // which programs run under the command
    std::thread procsThread([&] {
        std::string last;
        while (!finished)
        {
            auto names = RunningProgramNames(pid);
            if (names != last)
            {
                SendFrame(ToParentProcs, names.data(), static_cast<uint32_t>(names.size()));
                last = std::move(names);
            }
            for (int i = 0; i < 5 && !finished; i++)
            {
                Sleep(100);
            }
        }
    });

    // The command ended. The pseudo console draws its last output a moment later, so wait until the output has been quiet
    // for a while (or has ended by itself) before closing it, and report the end only when everything was delivered.
    std::thread exitThread([&] {
        WaitForSingleObject(process.hProcess, INFINITE);
        DWORD code = 0;
        GetExitCodeProcess(process.hProcess, &code);
        Trace("the command ended with code " + std::to_string(code));
        const ULONGLONG endedAt = GetTickCount64();
        while (!outputDone)
        {
            const ULONGLONG now = GetTickCount64();
            const ULONGLONG lastOutput = std::max<ULONGLONG>(g_lastOutputTick, endedAt);
            if (now - lastOutput > 250 || now - endedAt > 3000)
            {
                break;
            }
            Sleep(20);
        }
        {
            std::lock_guard<std::mutex> lock(g_consoleLock);
            if (pseudoConsole)
            {
                g_closePty(pseudoConsole);   // makes the output pipe end
                pseudoConsole = nullptr;
            }
        }
        Trace("pseudo console closed, waiting for the output to end");
        outputThread.join();
        Trace("the output ended");
        finished = true;
        SendFrame(ToParentExit, &code, sizeof(code));
        Trace("exit frame sent");
        ExitProcess(0);
    });

    // parent -> program
    for (;;)
    {
        uint8_t header[5];
        if (!ReadExact(stdinHandle, header, sizeof(header)))
        {
            Trace("the parent closed stdin");
            break;
        }
        uint32_t length = 0;
        std::memcpy(&length, header + 1, 4);
        std::vector<uint8_t> payload(length);
        if (length && !ReadExact(stdinHandle, payload.data(), length))
        {
            break;
        }
        if (header[0] == FromParentInput)
        {
            DWORD written = 0;
            WriteFile(inputWrite, payload.data(), length, &written, nullptr);
        }
        else if (header[0] == FromParentResize && length >= 4)
        {
            uint16_t c = 0, r = 0;
            std::memcpy(&c, payload.data(), 2);
            std::memcpy(&r, payload.data() + 2, 2);
            std::lock_guard<std::mutex> lock(g_consoleLock);
            if (pseudoConsole)
            {
                g_resizePty(pseudoConsole, COORD{ static_cast<SHORT>(std::max<uint16_t>(1, c)), static_cast<SHORT>(std::max<uint16_t>(1, r)) });
            }
        }
        else if (header[0] == FromParentClear)
        {
            // When the terminal clears its screen, the pseudo console still holds what was on it and draws it again at the next
            // resize. The function that clears it is not in Windows; it is in the conpty.dll that VS Code ships (g_clearPty is set
            // only then). Without it, only the terminal in front is cleared.
            std::lock_guard<std::mutex> lock(g_consoleLock);
            if (pseudoConsole && g_clearPty)
            {
                g_clearPty(pseudoConsole, (length >= 1 && payload[0]) ? TRUE : FALSE);
                Trace("cleared the pseudo console");
            }
            else
            {
                Trace("clear: this pseudo console cannot be cleared");
            }
        }
    }

    // The parent went away: close the pseudo console, which ends the command and what it started.
    finished = true;
    {
        std::lock_guard<std::mutex> lock(g_consoleLock);
        if (pseudoConsole)
        {
            g_closePty(pseudoConsole);
            pseudoConsole = nullptr;
        }
    }
    TerminateProcess(process.hProcess, 1);
    ExitProcess(0);
}
