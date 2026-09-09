$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Initialize-XbbVerifiedProcessHandleType {
    if ('Codex.Xbb.VerifiedProcessHandle' -as [type]) { return }
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Codex.Xbb
{
    public sealed class VerifiedProcessHandle : IDisposable
    {
        private const uint PROCESS_TERMINATE = 0x0001;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint WAIT_TIMEOUT = 0x00000102;
        private IntPtr handle;

        public int ProcessId { get; private set; }
        public string CreationToken { get; private set; }
        public string ExecutablePath { get; private set; }

        private VerifiedProcessHandle(IntPtr value, int processId, string creationToken, string executablePath)
        {
            handle = value;
            ProcessId = processId;
            CreationToken = creationToken;
            ExecutablePath = executablePath;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint Low;
            public uint High;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr value);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetProcessId(IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LocalFree(IntPtr value);

        private static long CanonicalCreationTicks(FILETIME value)
        {
            long fileTime = ((long)value.High << 32) | value.Low;
            long ticks = DateTime.FromFileTimeUtc(fileTime).Ticks;
            return ticks - (ticks % 10L);
        }

        private static string CanonicalPath(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value)) throw new ArgumentException("Executable path is not absolute.");
            string normalized = value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)
                ? @"\\" + value.Substring(8)
                : value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) ? value.Substring(4) : value;
            return Path.GetFullPath(normalized);
        }

        public static VerifiedProcessHandle OpenVerified(int expectedPid, string expectedCreationToken, string expectedExecutablePath)
        {
            if (expectedPid <= 0 || String.IsNullOrWhiteSpace(expectedCreationToken)) throw new ArgumentException("Expected process identity is invalid.");
            string expectedImage = CanonicalPath(expectedExecutablePath);
            IntPtr value = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, expectedPid);
            if (value == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed.");
            try
            {
                uint actualPid = GetProcessId(value);
                if (actualPid != (uint)expectedPid) throw new InvalidOperationException("Process handle PID mismatch.");
                FILETIME creation, exit, kernel, user;
                if (!GetProcessTimes(value, out creation, out exit, out kernel, out user))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetProcessTimes failed.");
                long parsedExpectedCreation;
                if (!Int64.TryParse(expectedCreationToken, System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture, out parsedExpectedCreation))
                    throw new ArgumentException("Expected creation identity is invalid.");
                long expectedCanonicalCreation = parsedExpectedCreation - (parsedExpectedCreation % 10L);
                long actualCanonicalCreation = CanonicalCreationTicks(creation);
                if (actualCanonicalCreation != expectedCanonicalCreation)
                    throw new InvalidOperationException("Process handle creation identity mismatch.");
                StringBuilder image = new StringBuilder(32768);
                int size = image.Capacity;
                if (!QueryFullProcessImageName(value, 0, image, ref size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryFullProcessImageName failed.");
                string actualImage = CanonicalPath(image.ToString());
                if (!String.Equals(actualImage, expectedImage, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Process handle executable identity mismatch.");
                VerifiedProcessHandle result = new VerifiedProcessHandle(value, expectedPid,
                    actualCanonicalCreation.ToString(System.Globalization.CultureInfo.InvariantCulture), actualImage);
                value = IntPtr.Zero;
                return result;
            }
            finally
            {
                if (value != IntPtr.Zero) CloseHandle(value);
            }
        }

        public static string[] ParseCommandLine(string commandLine)
        {
            if (String.IsNullOrWhiteSpace(commandLine)) throw new ArgumentException("Command line is empty.");
            int count;
            IntPtr values = CommandLineToArgvW(commandLine, out count);
            if (values == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CommandLineToArgvW failed.");
            try
            {
                if (count <= 0 || count > 256) throw new InvalidOperationException("Command-line argument count is invalid.");
                string[] result = new string[count];
                for (int index = 0; index < count; index++)
                {
                    IntPtr value = Marshal.ReadIntPtr(values, index * IntPtr.Size);
                    result[index] = Marshal.PtrToStringUni(value);
                    if (result[index] == null) throw new InvalidOperationException("Command-line argument is unreadable.");
                }
                return result;
            }
            finally
            {
                LocalFree(values);
            }
        }

        public bool HasExited
        {
            get
            {
                ThrowIfDisposed();
                uint result = WaitForSingleObject(handle, 0);
                if (result == WAIT_OBJECT_0) return true;
                if (result == WAIT_TIMEOUT) return false;
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed.");
            }
        }

        public bool WaitForExit(int milliseconds)
        {
            ThrowIfDisposed();
            if (milliseconds < 0) throw new ArgumentOutOfRangeException("milliseconds");
            uint result = WaitForSingleObject(handle, (uint)milliseconds);
            if (result == WAIT_OBJECT_0) return true;
            if (result == WAIT_TIMEOUT) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed.");
        }

        public bool TerminateAndWait(uint exitCode, int milliseconds)
        {
            ThrowIfDisposed();
            if (HasExited) return true;
            if (!TerminateProcess(handle, exitCode))
            {
                int errorCode = Marshal.GetLastWin32Error();
                if (HasExited) return true;
                throw new Win32Exception(errorCode, "TerminateProcess failed.");
            }
            return WaitForExit(milliseconds);
        }

        private void ThrowIfDisposed()
        {
            if (handle == IntPtr.Zero) throw new ObjectDisposedException("VerifiedProcessHandle");
        }

        public void Dispose()
        {
            if (handle == IntPtr.Zero) return;
            CloseHandle(handle);
            handle = IntPtr.Zero;
            GC.SuppressFinalize(this);
        }

        ~VerifiedProcessHandle() { Dispose(); }
    }
}
'@
}

function Open-XbbVerifiedProcessHandle($Identity) {
    if ($null -eq $Identity) { throw 'Verified process identity is required.' }
    Initialize-XbbVerifiedProcessHandleType
    return [Codex.Xbb.VerifiedProcessHandle]::OpenVerified(
        [int]$Identity.ProcessId,
        [string]$Identity.CreationToken,
        [string]$Identity.ExecutablePath
    )
}

function ConvertFrom-XbbWindowsCommandLine([string]$CommandLine) {
    Initialize-XbbVerifiedProcessHandleType
    return @([Codex.Xbb.VerifiedProcessHandle]::ParseCommandLine($CommandLine))
}

function Test-XbbCanonicalCommandPath([string]$Value, [string]$ExpectedPath) {
    if ([string]::IsNullOrWhiteSpace($Value) -or [string]::IsNullOrWhiteSpace($ExpectedPath)) { return $false }
    try {
        return [IO.Path]::GetFullPath($Value).Equals(
            [IO.Path]::GetFullPath($ExpectedPath),
            [StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Test-XbbPowerShellExecutableArgument(
    [string]$Value,
    [string]$ExpectedExecutablePath,
    [string]$ExpectedProcessName
) {
    if ([string]::IsNullOrWhiteSpace($Value) -or [string]::IsNullOrWhiteSpace($ExpectedExecutablePath) -or
        [string]::IsNullOrWhiteSpace($ExpectedProcessName)) { return $false }
    if ([IO.Path]::IsPathRooted($Value)) {
        return Test-XbbCanonicalCommandPath $Value $ExpectedExecutablePath
    }
    return $Value.IndexOfAny([char[]]@('\', '/')) -lt 0 -and
        $Value.Equals($ExpectedProcessName, [StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-XbbStrictPowerShellInvocation(
    [string]$CommandLine,
    [string]$ExpectedExecutablePath,
    [string]$ExpectedProcessName,
    [string]$ExpectedScriptPath,
    [string[]]$AllowedValueParameters = @(),
    [string[]]$RequiredValueParameters = @(),
    [string[]]$AllowedSwitchParameters = @(),
    [string[]]$RequiredSwitchParameters = @()
) {
    $arguments = @(ConvertFrom-XbbWindowsCommandLine $CommandLine)
    $expectedPrefix = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File')
    if ($arguments.Count -lt 8 -or
        -not (Test-XbbPowerShellExecutableArgument $arguments[0] $ExpectedExecutablePath $ExpectedProcessName)) {
        throw 'PowerShell host argv prefix is invalid.'
    }
    for ($index = 0; $index -lt $expectedPrefix.Count; $index += 1) {
        if (-not ([string]$arguments[$index + 1]).Equals($expectedPrefix[$index], [StringComparison]::OrdinalIgnoreCase)) {
            throw 'PowerShell host argv prefix is invalid.'
        }
    }
    if (-not (Test-XbbCanonicalCommandPath $arguments[7] $ExpectedScriptPath)) {
        throw 'PowerShell host entry script is invalid.'
    }

    $allowedValues = @{}
    $allowedSwitches = @{}
    foreach ($parameter in @($AllowedValueParameters)) {
        if ([string]$parameter -cnotmatch '^-[A-Za-z][A-Za-z0-9]*$' -or
            $allowedValues.ContainsKey([string]$parameter) -or $allowedSwitches.ContainsKey([string]$parameter)) {
            throw 'PowerShell value-parameter schema is invalid.'
        }
        $allowedValues[[string]$parameter] = [string]$parameter
    }
    foreach ($parameter in @($AllowedSwitchParameters)) {
        if ([string]$parameter -cnotmatch '^-[A-Za-z][A-Za-z0-9]*$' -or
            $allowedValues.ContainsKey([string]$parameter) -or $allowedSwitches.ContainsKey([string]$parameter)) {
            throw 'PowerShell switch-parameter schema is invalid.'
        }
        $allowedSwitches[[string]$parameter] = [string]$parameter
    }
    foreach ($parameter in @($RequiredValueParameters)) {
        if (-not $allowedValues.ContainsKey([string]$parameter)) { throw 'Required PowerShell value parameter is not allowed.' }
    }
    foreach ($parameter in @($RequiredSwitchParameters)) {
        if (-not $allowedSwitches.ContainsKey([string]$parameter)) { throw 'Required PowerShell switch parameter is not allowed.' }
    }

    $values = @{}
    $switches = @{}
    for ($index = 8; $index -lt $arguments.Count; $index += 1) {
        $argument = [string]$arguments[$index]
        if ($allowedValues.ContainsKey($argument)) {
            $canonicalName = [string]$allowedValues[$argument]
            if ($values.ContainsKey($canonicalName) -or $switches.ContainsKey($canonicalName) -or
                $index + 1 -ge $arguments.Count -or [string]::IsNullOrWhiteSpace([string]$arguments[$index + 1])) {
                throw 'PowerShell script value parameter is duplicated or missing its value.'
            }
            $values[$canonicalName] = [string]$arguments[$index + 1]
            $index += 1
        } elseif ($allowedSwitches.ContainsKey($argument)) {
            $canonicalName = [string]$allowedSwitches[$argument]
            if ($values.ContainsKey($canonicalName) -or $switches.ContainsKey($canonicalName)) {
                throw 'PowerShell script switch parameter is duplicated.'
            }
            $switches[$canonicalName] = $true
        } else {
            # This rejects all host aliases/abbreviations and competing modes
            # such as -Command, -c, -EncodedCommand and -ConfigurationName,
            # whether they appear before or after the fixed -File prefix.
            throw 'PowerShell script argv contains a non-whitelisted parameter.'
        }
    }
    foreach ($parameter in @($RequiredValueParameters)) {
        if (-not $values.ContainsKey([string]$parameter)) { throw 'Required PowerShell value parameter is missing.' }
    }
    foreach ($parameter in @($RequiredSwitchParameters)) {
        if (-not $switches.ContainsKey([string]$parameter)) { throw 'Required PowerShell switch parameter is missing.' }
    }
    return [pscustomobject]@{
        Arguments = $arguments
        Values = $values
        Switches = $switches
        ScriptPath = [IO.Path]::GetFullPath($ExpectedScriptPath)
    }
}
