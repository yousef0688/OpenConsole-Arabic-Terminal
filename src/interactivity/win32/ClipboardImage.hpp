// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

#pragma once

// Pasting an image (a screenshot, "Copy image" in a browser, ...) into a program that reads text: The image is saved as a
// PNG file, and the path of that file is pasted, exactly like it is when the file is dragged into the console window.
namespace Microsoft::Console::Interactivity::Win32::ClipboardImage
{
    // Returns the length of the PNG file that starts at the beginning of data, or 0 if that isn't a complete PNG file.
    // The memory the clipboard hands out is often larger than what was put into it, so the end has to be found.
    size_t PngLength(std::span<const BYTE> data) noexcept;

    // Converts a packed DIB (the content of the clipboard format CF_DIB or CF_DIBV5) into a PNG file.
    // Needs COM to be initialized on the calling thread.
    [[nodiscard]] HRESULT DibToPngFile(std::span<const BYTE> dib, const wchar_t* path) noexcept;

    // Returns %TEMP%\OpenConsole\clipboard-<date>-<time>.png. Creates the folder, and removes the files in there that are older than a week.
    [[nodiscard]] std::wstring NewImagePath();
}
