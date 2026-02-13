using System;
using System.Diagnostics;
using System.Text;

namespace HtmlToPrefab.Editor
{
    internal sealed class NodeRunResult
    {
        public int ExitCode;
        public string StdOut = string.Empty;
        public string StdErr = string.Empty;
        public bool Success => ExitCode == 0;
    }

    internal static class NodeBakeRunner
    {
        public static NodeRunResult Run(string executable, string arguments, string workingDirectory, int timeoutMs = 300000)
        {
            var result = new NodeRunResult();
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();

            try
            {
                using (var process = new Process())
                {
                    process.StartInfo = new ProcessStartInfo
                    {
                        FileName = executable,
                        Arguments = arguments,
                        WorkingDirectory = workingDirectory,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        CreateNoWindow = true
                    };

                    process.OutputDataReceived += (_, evt) =>
                    {
                        if (evt.Data != null)
                        {
                            stdout.AppendLine(evt.Data);
                        }
                    };

                    process.ErrorDataReceived += (_, evt) =>
                    {
                        if (evt.Data != null)
                        {
                            stderr.AppendLine(evt.Data);
                        }
                    };

                    if (!process.Start())
                    {
                        result.ExitCode = -1;
                        result.StdErr = "Failed to start node process.";
                        return result;
                    }

                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();

                    if (!process.WaitForExit(timeoutMs))
                    {
                        try
                        {
                            process.Kill();
                        }
                        catch
                        {
                            // Ignore kill failures after timeout.
                        }

                        result.ExitCode = -2;
                        result.StdOut = stdout.ToString();
                        result.StdErr = $"Process timed out after {timeoutMs}ms.{Environment.NewLine}{stderr}";
                        return result;
                    }

                    process.WaitForExit();
                    result.ExitCode = process.ExitCode;
                    result.StdOut = stdout.ToString();
                    result.StdErr = stderr.ToString();
                    return result;
                }
            }
            catch (Exception ex)
            {
                result.ExitCode = -1;
                result.StdOut = stdout.ToString();
                result.StdErr = $"{stderr}{Environment.NewLine}{ex}";
                return result;
            }
        }
    }
}
