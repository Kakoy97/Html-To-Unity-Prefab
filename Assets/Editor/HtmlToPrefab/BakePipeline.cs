using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace HtmlToPrefab.Editor
{
    internal sealed class BakeRequest
    {
        public string HtmlAbsolutePath = string.Empty;
        public string NodeExecutable = "node";
        public string RootSelector = string.Empty;
        public bool Debug;
        public bool BakeRotation;
        public bool StableIds = true;
        public int ViewportWidth = 750;
        public int ViewportHeight = 1624;
        public float DeviceScaleFactor = 1f;
    }

    internal sealed class BakeResult
    {
        public bool Success;
        public string Message = string.Empty;
        public string Log = string.Empty;
        public string OutputAssetFolder = string.Empty;
        public string UiIndexAssetPath = string.Empty;
        public string PrefabAssetPath = string.Empty;
    }

    internal static class BakePipeline
    {
        public static BakeResult Run(BakeRequest request)
        {
            var result = new BakeResult();
            if (request == null)
            {
                result.Message = "Bake request is null.";
                return result;
            }

            var htmlPath = request.HtmlAbsolutePath?.Trim() ?? string.Empty;
            if (string.IsNullOrEmpty(htmlPath) || !File.Exists(htmlPath))
            {
                result.Message = $"HTML file not found: {htmlPath}";
                return result;
            }

            var projectRoot = Directory.GetParent(Application.dataPath)?.FullName;
            if (string.IsNullOrEmpty(projectRoot))
            {
                result.Message = "Cannot resolve Unity project root.";
                return result;
            }

            var bakerRoot = Path.Combine(projectRoot, "tool", "UIBaker");
            var bakeScript = Path.Combine(bakerRoot, "bake_ui.js");
            if (!File.Exists(bakeScript))
            {
                result.Message = $"Missing bake script: {bakeScript}";
                return result;
            }

            var htmlName = SanitizeName(Path.GetFileNameWithoutExtension(htmlPath));
            if (string.IsNullOrEmpty(htmlName))
            {
                htmlName = "HtmlBaked";
            }

            var tempOutput = Path.Combine(projectRoot, "Temp", "HtmlToPrefab", htmlName, "output");
            Directory.CreateDirectory(Path.GetDirectoryName(tempOutput) ?? projectRoot);

            var args = BuildBakeArgs(bakeScript, htmlPath, tempOutput, request);
            var nodeResult = NodeBakeRunner.Run(
                request.NodeExecutable,
                args,
                bakerRoot
            );

            if (!nodeResult.Success)
            {
                result.Message = $"Node bake failed (exit code {nodeResult.ExitCode}).";
                result.Log = MergeLogs(nodeResult.StdOut, nodeResult.StdErr);
                return result;
            }

            var layoutPath = Path.Combine(tempOutput, "layout.json");
            if (!File.Exists(layoutPath))
            {
                result.Message = $"Bake succeeded but layout.json not found: {layoutPath}";
                result.Log = MergeLogs(nodeResult.StdOut, nodeResult.StdErr);
                return result;
            }

            try
            {
                var targetFolderAbs = Path.Combine(projectRoot, "Assets", "Resources", "UI", htmlName);
                SyncDirectory(tempOutput, targetFolderAbs);

                var uiFolderAssetPath = ToAssetPath(projectRoot, targetFolderAbs);
                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
                UiAssetImporter.ApplyTextureRules(uiFolderAssetPath);
                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);

                var layoutAssetPath = $"{uiFolderAssetPath}/layout.json".Replace('\\', '/');
                var layoutRoot = LayoutJsonLoader.LoadFromAssetPath(layoutAssetPath);
                var uiIndexAssetPath = LayoutIndexBuilder.WriteIndex(layoutRoot, htmlName, uiFolderAssetPath);
                AssetDatabase.ImportAsset(uiIndexAssetPath, ImportAssetOptions.ForceSynchronousImport);

                var prefabAssetPath = PrefabBuilder.Build(
                    layoutRoot,
                    htmlName,
                    uiFolderAssetPath,
                    request.ViewportWidth,
                    request.ViewportHeight
                );
                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);

                result.Success = true;
                result.OutputAssetFolder = uiFolderAssetPath;
                result.UiIndexAssetPath = uiIndexAssetPath;
                result.PrefabAssetPath = prefabAssetPath;
                result.Message = $"Bake completed: {result.OutputAssetFolder} | {result.PrefabAssetPath}";
                result.Log = MergeLogs(nodeResult.StdOut, nodeResult.StdErr);
                return result;
            }
            catch (Exception ex)
            {
                result.Message = $"Post-bake processing failed: {ex.Message}";
                result.Log = MergeLogs(nodeResult.StdOut, $"{nodeResult.StdErr}{Environment.NewLine}{ex}");
                return result;
            }
        }

        private static string BuildBakeArgs(
            string bakeScriptPath,
            string htmlPath,
            string outputDir,
            BakeRequest request
        )
        {
            var args = new List<string>
            {
                Quote(bakeScriptPath),
                Quote(htmlPath),
                Quote($"--output-dir={outputDir}"),
                $"--viewport-width={Mathf.Max(1, request.ViewportWidth)}",
                $"--viewport-height={Mathf.Max(1, request.ViewportHeight)}",
                $"--device-scale-factor={Mathf.Max(0.01f, request.DeviceScaleFactor).ToString("0.###", CultureInfo.InvariantCulture)}",
                request.StableIds ? "--id-mode=stable" : "--id-mode=uuid"
            };

            if (request.Debug)
            {
                args.Add("--debug");
            }

            if (request.BakeRotation)
            {
                args.Add("--bake-rotation");
            }

            if (!string.IsNullOrWhiteSpace(request.RootSelector))
            {
                args.Add(Quote($"--root-selector={request.RootSelector.Trim()}"));
            }

            return string.Join(" ", args);
        }

        private static string MergeLogs(string stdout, string stderr)
        {
            var builder = new StringBuilder();
            if (!string.IsNullOrEmpty(stdout))
            {
                builder.AppendLine("[stdout]");
                builder.AppendLine(stdout.TrimEnd());
            }

            if (!string.IsNullOrEmpty(stderr))
            {
                if (builder.Length > 0) builder.AppendLine();
                builder.AppendLine("[stderr]");
                builder.AppendLine(stderr.TrimEnd());
            }

            return builder.ToString().TrimEnd();
        }

        private static string Quote(string value)
        {
            return $"\"{value.Replace("\"", "\\\"")}\"";
        }

        private static string SanitizeName(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            foreach (var invalid in Path.GetInvalidFileNameChars())
            {
                value = value.Replace(invalid, '_');
            }

            return value.Trim();
        }

        private static string ToAssetPath(string projectRoot, string absolutePath)
        {
            var normalizedProjectRoot = projectRoot.Replace('\\', '/').TrimEnd('/');
            var normalizedAbsolute = absolutePath.Replace('\\', '/');
            if (!normalizedAbsolute.StartsWith(normalizedProjectRoot, StringComparison.OrdinalIgnoreCase))
            {
                return absolutePath;
            }

            return normalizedAbsolute.Substring(normalizedProjectRoot.Length + 1);
        }

        private static void SyncDirectory(string sourceDir, string targetDir)
        {
            if (!Directory.Exists(sourceDir))
            {
                throw new DirectoryNotFoundException($"Source directory not found: {sourceDir}");
            }

            if (Directory.Exists(targetDir))
            {
                Directory.Delete(targetDir, true);
            }

            CopyDirectory(sourceDir, targetDir);
        }

        private static void CopyDirectory(string sourceDir, string targetDir)
        {
            Directory.CreateDirectory(targetDir);

            foreach (var filePath in Directory.GetFiles(sourceDir))
            {
                var fileName = Path.GetFileName(filePath);
                var targetFile = Path.Combine(targetDir, fileName);
                File.Copy(filePath, targetFile, true);
            }

            foreach (var childSource in Directory.GetDirectories(sourceDir))
            {
                var childName = Path.GetFileName(childSource);
                var childTarget = Path.Combine(targetDir, childName);
                CopyDirectory(childSource, childTarget);
            }
        }
    }
}
