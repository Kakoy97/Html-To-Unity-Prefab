using System.Collections.Generic;
using System.IO;
using System.Linq;
using HtmlToPrefab.Runtime;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace HtmlToPrefab.Editor.Repair
{
    [CustomEditor(typeof(UiNodeRef))]
    internal sealed class UiNodeRefRepairInspector : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            DrawDefaultInspector();
            EditorGUILayout.Space(8f);

            var nodeRef = target as UiNodeRef;
            if (nodeRef == null)
            {
                return;
            }

            using (new EditorGUI.DisabledScope(string.IsNullOrWhiteSpace(nodeRef.NodeId)))
            {
                if (GUILayout.Button("Smart Repair", GUILayout.Height(32f)))
                {
                    var htmlPath = ResolveHtmlPath(nodeRef);
                    var imageAssetPath = ResolveImageAssetPath(nodeRef);
                    NodeRepairWindow.OpenForNode(nodeRef, htmlPath, imageAssetPath);
                }
            }

            if (string.IsNullOrWhiteSpace(nodeRef.NodeId))
            {
                EditorGUILayout.HelpBox("NodeId is empty. Repair is unavailable.", MessageType.Warning);
            }
        }

        private static string ResolveImageAssetPath(UiNodeRef nodeRef)
        {
            if (nodeRef == null) return string.Empty;

            Image preferred = null;
            var images = nodeRef.GetComponentsInChildren<Image>(true);
            for (var i = 0; i < images.Length; i++)
            {
                var img = images[i];
                if (img == null || img.sprite == null) continue;
                if (img.transform.name == "__visual")
                {
                    preferred = img;
                    break;
                }
                if (preferred == null)
                {
                    preferred = img;
                }
            }

            if (preferred == null || preferred.sprite == null) return string.Empty;
            return AssetDatabase.GetAssetPath(preferred.sprite);
        }

        private static string ResolveHtmlPath(UiNodeRef nodeRef)
        {
            var projectRoot = Directory.GetParent(Application.dataPath)?.FullName;
            if (string.IsNullOrEmpty(projectRoot))
            {
                return string.Empty;
            }

            var rootName = GetSafeRootName(nodeRef);
            var candidates = new List<string>();
            if (!string.IsNullOrWhiteSpace(rootName))
            {
                candidates.Add(Path.Combine(projectRoot, $"{rootName}.html"));
                candidates.Add(Path.Combine(projectRoot, $"{rootName}.htm"));
                candidates.Add(Path.Combine(projectRoot, "test", $"{rootName}.html"));
                candidates.Add(Path.Combine(projectRoot, "test", $"{rootName}.htm"));
                candidates.Add(Path.Combine(projectRoot, "tool", "UIBaker", "test", $"{rootName}.html"));
                candidates.Add(Path.Combine(projectRoot, "tool", "UIBaker", "test", $"{rootName}.htm"));
            }

            for (var i = 0; i < candidates.Count; i++)
            {
                if (File.Exists(candidates[i]))
                {
                    return candidates[i];
                }
            }

            if (nodeRef != null && TryResolveHtmlPathByAnalysisTree(projectRoot, nodeRef.NodeId, out var matchedHtmlPath))
            {
                return matchedHtmlPath;
            }

            var remembered = EditorPrefs.GetString(HtmlBakeWindow.LastHtmlPathEditorPrefKey, string.Empty);
            if (!string.IsNullOrWhiteSpace(remembered) && File.Exists(remembered))
            {
                return remembered;
            }

            return string.Empty;
        }

        private static string GetSafeRootName(UiNodeRef nodeRef)
        {
            var rawName = nodeRef != null && nodeRef.transform != null && nodeRef.transform.root != null
                ? nodeRef.transform.root.name
                : string.Empty;
            if (string.IsNullOrWhiteSpace(rawName))
            {
                return string.Empty;
            }

            var sanitized = rawName.Trim();
            const string cloneSuffix = "(Clone)";
            if (sanitized.EndsWith(cloneSuffix))
            {
                sanitized = sanitized.Substring(0, sanitized.Length - cloneSuffix.Length).Trim();
            }
            return sanitized;
        }

        private static bool TryResolveHtmlPathByAnalysisTree(string projectRoot, string nodeId, out string htmlPath)
        {
            htmlPath = string.Empty;
            if (string.IsNullOrWhiteSpace(projectRoot) || string.IsNullOrWhiteSpace(nodeId))
            {
                return false;
            }

            var tempRoot = Path.Combine(projectRoot, "Temp", "HtmlToPrefab");
            if (!Directory.Exists(tempRoot))
            {
                return false;
            }

            string[] htmlDirs;
            try
            {
                htmlDirs = Directory.GetDirectories(tempRoot);
            }
            catch
            {
                return false;
            }

            for (var i = 0; i < htmlDirs.Length; i++)
            {
                var htmlDir = htmlDirs[i];
                var analysisPath = Path.Combine(htmlDir, "output", "debug", "analysis_tree.json");
                if (!File.Exists(analysisPath))
                {
                    continue;
                }

                try
                {
                    var raw = File.ReadAllText(analysisPath);
                    if (!raw.Contains(nodeId))
                    {
                        continue;
                    }
                }
                catch
                {
                    continue;
                }

                var htmlName = Path.GetFileName(htmlDir);
                if (string.IsNullOrWhiteSpace(htmlName))
                {
                    continue;
                }

                var htmlCandidates = new[]
                {
                    Path.Combine(projectRoot, $"{htmlName}.html"),
                    Path.Combine(projectRoot, $"{htmlName}.htm"),
                    Path.Combine(projectRoot, "test", $"{htmlName}.html"),
                    Path.Combine(projectRoot, "test", $"{htmlName}.htm"),
                    Path.Combine(projectRoot, "tool", "UIBaker", "test", $"{htmlName}.html"),
                    Path.Combine(projectRoot, "tool", "UIBaker", "test", $"{htmlName}.htm"),
                };

                htmlPath = htmlCandidates.FirstOrDefault(File.Exists) ?? string.Empty;
                if (!string.IsNullOrWhiteSpace(htmlPath))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
