// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "precomp.h"

#include "ClipboardImage.hpp"

#include <wincodec.h>

using namespace Microsoft::Console::Interactivity::Win32;

namespace
{
    // CLSID_WICImagingFactory and GUID_ContainerFormatPng. They are spelled out here to not depend on windowscodecs.lib.
    constexpr GUID clsidImagingFactory{ 0xcacaf262, 0x9370, 0x4615, { 0xa1, 0x3b, 0x9f, 0x55, 0x39, 0xda, 0x4c, 0x0a } };
    constexpr GUID containerFormatPng{ 0x1b7cfaf4, 0x713f, 0x473c, { 0xbb, 0xcd, 0x61, 0x37, 0x42, 0x5f, 0xae, 0xaf } };

    constexpr uint64_t oneWeek = 7ull * 24 * 60 * 60 * 10'000'000; // in units of 100ns, like FILETIME

    uint32_t readBigEndian(const BYTE* p) noexcept
    {
        return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) | (static_cast<uint32_t>(p[2]) << 8) | p[3];
    }
}

size_t ClipboardImage::PngLength(const std::span<const BYTE> data) noexcept
{
    static constexpr BYTE signature[8]{ 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
    if (data.size() < sizeof(signature) || memcmp(data.data(), signature, sizeof(signature)) != 0)
    {
        return 0;
    }

    // A PNG file is the signature, followed by chunks of: length (4 bytes), type (4), data (length), CRC (4).
    // The last chunk is of the type IEND.
    size_t pos = sizeof(signature);
    while (pos + 12 <= data.size())
    {
        const size_t length = readBigEndian(data.data() + pos);
        if (length > data.size() - pos - 12)
        {
            return 0;
        }

        const auto isEnd = memcmp(data.data() + pos + 4, "IEND", 4) == 0;
        pos += 12 + length;
        if (isEnd)
        {
            return pos;
        }
    }
    return 0;
}

HRESULT ClipboardImage::DibToPngFile(const std::span<const BYTE> dib, const wchar_t* const path) noexcept
try
{
    RETURN_HR_IF(E_INVALIDARG, dib.size() < sizeof(BITMAPINFOHEADER));

    BITMAPINFOHEADER header;
    memcpy(&header, dib.data(), sizeof(header));
    RETURN_HR_IF(E_INVALIDARG, header.biSize < sizeof(BITMAPINFOHEADER) || header.biSize > dib.size());

    // A DIB is a BMP file without the 14 bytes of its file header. Put the header back and let the BMP decoder of WIC
    // deal with all the variations of the format (bottom-up or top-down, palettes, bit masks, ...).
    size_t colors = header.biClrUsed;
    if (colors == 0 && header.biBitCount <= 8)
    {
        colors = size_t{ 1 } << header.biBitCount;
    }
    const size_t masks = (header.biCompression == BI_BITFIELDS && header.biSize == sizeof(BITMAPINFOHEADER)) ? 3 * sizeof(DWORD) : 0;
    const size_t pixelOffset = sizeof(BITMAPFILEHEADER) + header.biSize + masks + colors * sizeof(RGBQUAD);
    RETURN_HR_IF(E_INVALIDARG, pixelOffset > sizeof(BITMAPFILEHEADER) + dib.size());

    std::vector<BYTE> bmp(sizeof(BITMAPFILEHEADER) + dib.size());
    BITMAPFILEHEADER fileHeader{};
    fileHeader.bfType = 0x4D42; // "BM"
    fileHeader.bfSize = gsl::narrow<DWORD>(bmp.size());
    fileHeader.bfOffBits = gsl::narrow<DWORD>(pixelOffset);
    memcpy(bmp.data(), &fileHeader, sizeof(fileHeader));
    memcpy(bmp.data() + sizeof(fileHeader), dib.data(), dib.size());

    const auto factory = wil::CoCreateInstance<IWICImagingFactory>(clsidImagingFactory);

    wil::com_ptr<IWICStream> input;
    THROW_IF_FAILED(factory->CreateStream(input.put()));
    THROW_IF_FAILED(input->InitializeFromMemory(bmp.data(), gsl::narrow<DWORD>(bmp.size())));

    wil::com_ptr<IWICBitmapDecoder> decoder;
    THROW_IF_FAILED(factory->CreateDecoderFromStream(input.get(), nullptr, WICDecodeMetadataCacheOnDemand, decoder.put()));
    wil::com_ptr<IWICBitmapFrameDecode> source;
    THROW_IF_FAILED(decoder->GetFrame(0, source.put()));

    UINT width = 0;
    UINT height = 0;
    THROW_IF_FAILED(source->GetSize(&width, &height));
    WICPixelFormatGUID format;
    THROW_IF_FAILED(source->GetPixelFormat(&format));

    wil::com_ptr<IWICStream> output;
    THROW_IF_FAILED(factory->CreateStream(output.put()));
    THROW_IF_FAILED(output->InitializeFromFilename(path, GENERIC_WRITE));

    wil::com_ptr<IWICBitmapEncoder> encoder;
    THROW_IF_FAILED(factory->CreateEncoder(containerFormatPng, nullptr, encoder.put()));
    THROW_IF_FAILED(encoder->Initialize(output.get(), WICBitmapEncoderNoCache));

    wil::com_ptr<IWICBitmapFrameEncode> target;
    wil::com_ptr<IPropertyBag2> options;
    THROW_IF_FAILED(encoder->CreateNewFrame(target.put(), options.put()));
    THROW_IF_FAILED(target->Initialize(options.get()));
    THROW_IF_FAILED(target->SetSize(width, height));
    // SetPixelFormat() replaces the format with the closest one the PNG encoder supports. WriteSource() converts to it.
    THROW_IF_FAILED(target->SetPixelFormat(&format));
    THROW_IF_FAILED(target->WriteSource(source.get(), nullptr));
    THROW_IF_FAILED(target->Commit());
    THROW_IF_FAILED(encoder->Commit());
    return S_OK;
}
CATCH_RETURN()

std::wstring ClipboardImage::NewImagePath()
{
    wchar_t temp[MAX_PATH + 2];
    const auto length = GetTempPathW(gsl::narrow_cast<DWORD>(std::size(temp)), &temp[0]);
    THROW_LAST_ERROR_IF(length == 0 || length >= std::size(temp));

    std::wstring folder{ &temp[0], length };
    folder += L"OpenConsole\\";
    if (!CreateDirectoryW(folder.c_str(), nullptr))
    {
        THROW_LAST_ERROR_IF(GetLastError() != ERROR_ALREADY_EXISTS);
    }

    // GetTempPathW() may return the short (8.3) spelling of the user's folder. The long one is what the user recognizes.
    wchar_t longName[MAX_PATH + 2];
    if (const auto longLength = GetLongPathNameW(folder.c_str(), &longName[0], gsl::narrow_cast<DWORD>(std::size(longName))); longLength > 0 && longLength < std::size(longName))
    {
        folder.assign(&longName[0], longLength);
        if (folder.back() != L'\\')
        {
            folder += L'\\';
        }
    }

    // Best effort: Screenshots pasted long ago aren't needed anymore.
    try
    {
        FILETIME now;
        GetSystemTimeAsFileTime(&now);
        const auto cutoff = ((static_cast<uint64_t>(now.dwHighDateTime) << 32) | now.dwLowDateTime) - oneWeek;

        WIN32_FIND_DATAW found;
        if (const wil::unique_hfind find{ FindFirstFileW((folder + L"clipboard-*.png").c_str(), &found) })
        {
            do
            {
                const auto written = (static_cast<uint64_t>(found.ftLastWriteTime.dwHighDateTime) << 32) | found.ftLastWriteTime.dwLowDateTime;
                if (written < cutoff)
                {
                    DeleteFileW((folder + &found.cFileName[0]).c_str());
                }
            } while (FindNextFileW(find.get(), &found));
        }
    }
    CATCH_LOG();

    SYSTEMTIME time;
    GetLocalTime(&time);
    wchar_t name[64];
    swprintf_s(&name[0], std::size(name), L"clipboard-%04u%02u%02u-%02u%02u%02u-%03u.png", time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds);
    return folder + &name[0];
}
