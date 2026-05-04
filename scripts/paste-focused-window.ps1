param(
  [Parameter(Mandatory = $true)]
  [string]$TextPath,

  [int]$DelayMs = 3000,

  [int]$PostPasteDelayMs = 200,

  [switch]$NoSubmit
)

Add-Type -AssemblyName System.Windows.Forms

$previousClipboard = $null

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class NativeKeyboardInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public UInt32 type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public UInt16 wVk;
        public UInt16 wScan;
        public UInt32 dwFlags;
        public UInt32 time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern UInt32 SendInput(UInt32 nInputs, INPUT[] pInputs, Int32 cbSize);

    public const UInt32 INPUT_KEYBOARD = 1;
    public const UInt32 KEYEVENTF_KEYUP = 0x0002;

    public static INPUT CreateKeyInput(UInt16 virtualKey, bool keyUp) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = virtualKey;
        input.U.ki.wScan = 0;
        input.U.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
        input.U.ki.time = 0;
        input.U.ki.dwExtraInfo = IntPtr.Zero;
        return input;
    }
}
"@

try {
  $previousClipboard = Get-Clipboard -Raw
} catch {
  $previousClipboard = $null
}

function Send-VirtualKey {
  param(
    [Parameter(Mandatory = $true)]
    [UInt16]$VirtualKey,

    [switch]$KeyUp
  )

  $input = [NativeKeyboardInput+INPUT[]]::new(1)
  $input[0] = [NativeKeyboardInput]::CreateKeyInput($VirtualKey, [bool]$KeyUp)
  [void][NativeKeyboardInput]::SendInput(1, $input, [System.Runtime.InteropServices.Marshal]::SizeOf([type][NativeKeyboardInput+INPUT]))
}

function Send-KeyChord {
  param(
    [Parameter(Mandatory = $true)]
    [UInt16]$ModifierKey,

    [Parameter(Mandatory = $true)]
    [UInt16]$MainKey
  )

  Send-VirtualKey -VirtualKey $ModifierKey
  Start-Sleep -Milliseconds 50
  Send-VirtualKey -VirtualKey $MainKey
  Start-Sleep -Milliseconds 50
  Send-VirtualKey -VirtualKey $MainKey -KeyUp
  Start-Sleep -Milliseconds 50
  Send-VirtualKey -VirtualKey $ModifierKey -KeyUp
}

$text = Get-Content -Path $TextPath -Raw -Encoding UTF8
Set-Clipboard -Value $text

Start-Sleep -Milliseconds $DelayMs

Send-KeyChord -ModifierKey 0x11 -MainKey 0x56

if (-not $NoSubmit) {
  Start-Sleep -Milliseconds $PostPasteDelayMs
  Send-VirtualKey -VirtualKey 0x0D
  Start-Sleep -Milliseconds 50
  Send-VirtualKey -VirtualKey 0x0D -KeyUp
}

if ($null -ne $previousClipboard) {
  Start-Sleep -Milliseconds 200
  Set-Clipboard -Value $previousClipboard
}
