// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#include "precomp.h"

#include "../inc/conint.h"

#include <dwmapi.h>
#include <uxtheme.h>

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "uxtheme.lib")

using namespace Microsoft::Console::Internal;

[[nodiscard]] HRESULT ProcessPolicy::CheckAppModelPolicy(const HANDLE /*hToken*/,
                                                         bool& fIsWrongWayBlocked) noexcept
{
    fIsWrongWayBlocked = false;
    return S_OK;
}

[[nodiscard]] HRESULT ProcessPolicy::CheckIntegrityLevelPolicy(const HANDLE /*hOtherToken*/,
                                                               bool& fIsWrongWayBlocked) noexcept
{
    fIsWrongWayBlocked = false;
    return S_OK;
}

// Gives the console window a dark title bar and dark scroll bars, in the colors of the Windows Terminal tab row.
// Nothing is changed while a high contrast theme is active, as those need to stay in control of all colors.
[[nodiscard]] HRESULT Theming::TrySetDarkMode(HWND hwnd) noexcept
{
    HIGHCONTRASTW highContrast{ .cbSize = sizeof(highContrast) };
    if (SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(highContrast), &highContrast, 0) && WI_IsFlagSet(highContrast.dwFlags, HCF_HIGHCONTRASTON))
    {
        return S_FALSE;
    }

    // These are the values of DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_CAPTION_COLOR and DWMWA_TEXT_COLOR.
    // The latter two only exist on Windows 11 and fail elsewhere, which just leaves the default dark title bar.
    static constexpr DWORD useImmersiveDarkMode = 20;
    static constexpr DWORD captionColor = 35;
    static constexpr DWORD textColor = 36;

    const BOOL dark = TRUE;
    RETURN_IF_FAILED(DwmSetWindowAttribute(hwnd, useImmersiveDarkMode, &dark, sizeof(dark)));

    const COLORREF caption = RGB(0x2E, 0x2E, 0x2E);
    const COLORREF text = RGB(0xFF, 0xFF, 0xFF);
    LOG_IF_FAILED(DwmSetWindowAttribute(hwnd, captionColor, &caption, sizeof(caption)));
    LOG_IF_FAILED(DwmSetWindowAttribute(hwnd, textColor, &text, sizeof(text)));

    LOG_IF_FAILED(SetWindowTheme(hwnd, L"DarkMode_Explorer", nullptr));
    return S_OK;
}
