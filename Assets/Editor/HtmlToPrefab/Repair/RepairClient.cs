using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace HtmlToPrefab.Editor.Repair
{
    [Serializable]
    internal sealed class RepairManualParams
    {
        public string strategy = string.Empty;
        public int expandPadding;
        public int contextPadding;
        public int width = 750;
        public int height = 1624;
        public float baseWidth = 375f;
        public float dpr;
        public bool stripText = true;
        public bool isolateNode = true;
        public bool hideChildren = true;
        public bool hideOwnText = true;
        public string nodeType = string.Empty;
        public string domPath = string.Empty;
        public string colorFilter = string.Empty;
        public string cssFilter = string.Empty;
    }

    [Serializable]
    internal sealed class RepairManifestPayload
    {
        public string targetNodeId = string.Empty;
        public string htmlPath = string.Empty;
        public string mode = "SMART_GENERATE";
        public string strategy = string.Empty;
        public RepairManualParams manualParams = new RepairManualParams();
        public bool dryRun = true;
    }

    [Serializable]
    internal sealed class RepairVariantMetadata
    {
        public string strategy = string.Empty;
        public float contentOffsetX;
        public float contentOffsetY;
        public float expandPadding;
    }

    [Serializable]
    internal sealed class RepairVariantPayload
    {
        public string id = string.Empty;
        public string name = string.Empty;
        public string imagePath = string.Empty;
        public string description = string.Empty;
        public RepairVariantMetadata metadata = new RepairVariantMetadata();
    }

    [Serializable]
    internal sealed class RepairResultPayload
    {
        public string nodeId = string.Empty;
        public List<RepairVariantPayload> variants = new List<RepairVariantPayload>();
    }

    internal sealed class RepairClientResponse
    {
        public bool Success;
        public string Message = string.Empty;
        public string StdOut = string.Empty;
        public string StdErr = string.Empty;
        public string ManifestPath = string.Empty;
        public RepairResultPayload Result;
    }

    internal static class RepairClient
    {
        private const int DefaultTimeoutMs = 120000;

        public static Task<RepairClientResponse> RunSmartGenerateAsync(string nodeId, string htmlPath, bool dryRun = true)
        {
            return RunSmartGenerateAsync(nodeId, htmlPath, null, dryRun);
        }

        public static Task<RepairClientResponse> RunSmartGenerateAsync(
            string nodeId,
            string htmlPath,
            RepairManualParams manualParams,
            bool dryRun = true
        )
        {
            var projectRoot = ResolveProjectRoot();
            return Task.Run(() => RunSmartGenerateInternal(nodeId, htmlPath, manualParams, dryRun, projectRoot));
        }

        public static RepairClientResponse RunSmartGenerate(string nodeId, string htmlPath, bool dryRun = true)
        {
            return RunSmartGenerate(nodeId, htmlPath, null, dryRun);
        }

        public static RepairClientResponse RunSmartGenerate(
            string nodeId,
            string htmlPath,
            RepairManualParams manualParams,
            bool dryRun = true
        )
        {
            var projectRoot = ResolveProjectRoot();
            return RunSmartGenerateInternal(nodeId, htmlPath, manualParams, dryRun, projectRoot);
        }

        public static Task<RepairClientResponse> RunManualAsync(
            string nodeId,
            string htmlPath,
            RepairManualParams manualParams,
            bool dryRun = true
        )
        {
            var projectRoot = ResolveProjectRoot();
            return Task.Run(() => RunManualInternal(nodeId, htmlPath, manualParams, dryRun, projectRoot));
        }

        public static RepairClientResponse RunManual(
            string nodeId,
            string htmlPath,
            RepairManualParams manualParams,
            bool dryRun = true
        )
        {
            var projectRoot = ResolveProjectRoot();
            return RunManualInternal(nodeId, htmlPath, manualParams, dryRun, projectRoot);
        }

        private static RepairClientResponse RunSmartGenerateInternal(
            string nodeId,
            string htmlPath,
            RepairManualParams manualParams,
            bool dryRun,
            string projectRoot
        )
        {
            return Run(new RepairManifestPayload
            {
                targetNodeId = nodeId ?? string.Empty,
                htmlPath = htmlPath ?? string.Empty,
                mode = "SMART_GENERATE",
                strategy = manualParams != null ? manualParams.strategy ?? string.Empty : string.Empty,
                manualParams = manualParams ?? new RepairManualParams(),
                dryRun = dryRun
            }, projectRoot);
        }

        private static RepairClientResponse RunManualInternal(
            string nodeId,
            string htmlPath,
            RepairManualParams manualParams,
            bool dryRun,
            string projectRoot
        )
        {
            return Run(new RepairManifestPayload
            {
                targetNodeId = nodeId ?? string.Empty,
                htmlPath = htmlPath ?? string.Empty,
                mode = "MANUAL",
                strategy = manualParams != null ? manualParams.strategy ?? string.Empty : string.Empty,
                manualParams = manualParams ?? new RepairManualParams(),
                dryRun = dryRun
            }, projectRoot);
        }

        public static RepairClientResponse Run(RepairManifestPayload payload, int timeoutMs = DefaultTimeoutMs)
        {
            var projectRoot = ResolveProjectRoot();
            return Run(payload, projectRoot, timeoutMs);
        }

        private static RepairClientResponse Run(
            RepairManifestPayload payload,
            string projectRoot,
            int timeoutMs = DefaultTimeoutMs
        )
        {
            var response = new RepairClientResponse();
            try
            {
                if (payload == null)
                {
                    response.Message = "Repair payload is null.";
                    return response;
                }

                if (string.IsNullOrWhiteSpace(payload.targetNodeId))
                {
                    response.Message = "Repair payload missing targetNodeId.";
                    return response;
                }

                if (string.IsNullOrWhiteSpace(payload.htmlPath) || !File.Exists(payload.htmlPath))
                {
                    response.Message = $"Repair payload htmlPath invalid: {payload.htmlPath}";
                    return response;
                }

                if (string.IsNullOrEmpty(projectRoot))
                {
                    response.Message = "Cannot resolve Unity project root.";
                    return response;
                }

                var cliPath = Path.Combine(projectRoot, "tool", "src", "repair", "cli.js");
                if (!File.Exists(cliPath))
                {
                    response.Message = $"Repair CLI not found: {cliPath}";
                    return response;
                }

                var manifestPath = WriteManifest(projectRoot, payload);
                response.ManifestPath = manifestPath;

                var runResult = RunNode(
                    "node",
                    $"{Quote(cliPath)} --manifest {Quote(manifestPath)}",
                    projectRoot,
                    timeoutMs
                );
                response.StdOut = runResult.StdOut;
                response.StdErr = runResult.StdErr;

                if (!runResult.Success)
                {
                    response.Message = $"Repair node process failed (exit {runResult.ExitCode}).";
                    return response;
                }

                if (!TryExtractJson(runResult.StdOut, out var json, out var extractError))
                {
                    response.Message = $"Repair output JSON parse failed: {extractError}";
                    return response;
                }

                var parsed = JsonUtility.FromJson<RepairResultPayload>(json);
                if (parsed == null || string.IsNullOrEmpty(parsed.nodeId))
                {
                    response.Message = "Repair output missing nodeId.";
                    return response;
                }

                if (parsed.variants == null)
                {
                    parsed.variants = new List<RepairVariantPayload>();
                }

                response.Result = parsed;
                response.Success = true;
                response.Message = "Repair completed.";
                return response;
            }
            catch (Exception ex)
            {
                response.Message = $"RepairClient exception: {ex.Message}";
                response.StdErr = ex.ToString();
                return response;
            }
        }

        private static string ResolveProjectRoot()
        {
            return Directory.GetParent(Application.dataPath)?.FullName ?? string.Empty;
        }

        private static string WriteManifest(string projectRoot, RepairManifestPayload payload)
        {
            var dir = Path.Combine(projectRoot, "Temp", "HtmlToPrefab", "Repair");
            Directory.CreateDirectory(dir);

            var safeNodeId = SanitizeToken(payload.targetNodeId);
            var fileName = $"repair_manifest_{safeNodeId}_{DateTime.UtcNow:yyyyMMdd_HHmmss_fff}.json";
            var manifestPath = Path.Combine(dir, fileName);
            var json = JsonUtility.ToJson(payload, true);
            File.WriteAllText(manifestPath, json);
            return manifestPath;
        }

        private static string SanitizeToken(string value)
        {
            var text = string.IsNullOrWhiteSpace(value) ? "node" : value.Trim();
            var chars = text.ToCharArray();
            for (var i = 0; i < chars.Length; i++)
            {
                var c = chars[i];
                if (char.IsLetterOrDigit(c) || c == '_' || c == '-') continue;
                chars[i] = '_';
            }

            return new string(chars);
        }

        private static string Quote(string value)
        {
            return $"\"{(value ?? string.Empty).Replace("\"", "\\\"")}\"";
        }

        private static bool TryExtractJson(string stdout, out string json, out string error)
        {
            json = string.Empty;
            error = string.Empty;
            var text = stdout ?? string.Empty;
            var start = text.IndexOf('{');
            var end = text.LastIndexOf('}');
            if (start < 0 || end <= start)
            {
                error = "No JSON object found in stdout.";
                return false;
            }

            json = text.Substring(start, end - start + 1);
            return true;
        }

        private sealed class NodeRunResult
        {
            public int ExitCode;
            public string StdOut = string.Empty;
            public string StdErr = string.Empty;
            public bool Success => ExitCode == 0;
        }

        private static NodeRunResult RunNode(string executable, string arguments, string workingDirectory, int timeoutMs)
        {
            var result = new NodeRunResult();
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();

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
                    CreateNoWindow = true,
                };

                process.OutputDataReceived += (_, evt) =>
                {
                    if (evt.Data != null) stdout.AppendLine(evt.Data);
                };
                process.ErrorDataReceived += (_, evt) =>
                {
                    if (evt.Data != null) stderr.AppendLine(evt.Data);
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
                        // ignore kill failures after timeout
                    }

                    result.ExitCode = -2;
                    result.StdOut = stdout.ToString();
                    result.StdErr = $"Node process timed out after {timeoutMs}ms.{Environment.NewLine}{stderr}";
                    return result;
                }

                process.WaitForExit();
                result.ExitCode = process.ExitCode;
                result.StdOut = stdout.ToString();
                result.StdErr = stderr.ToString();
                return result;
            }
        }
    }
}
