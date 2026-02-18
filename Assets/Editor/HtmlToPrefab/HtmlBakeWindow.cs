using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace HtmlToPrefab.Editor
{
    public sealed class HtmlBakeWindow : EditorWindow
    {
        internal const string LastHtmlPathEditorPrefKey = "HtmlToPrefab.LastHtmlPath";
        internal const string LastViewportWidthEditorPrefKey = "HtmlToPrefab.LastViewportWidth";
        internal const string LastViewportHeightEditorPrefKey = "HtmlToPrefab.LastViewportHeight";

        private string _htmlPath = string.Empty;
        private string _uiFolder = "Assets/Resources/UI";
        private int _viewportWidth = 750;
        private int _viewportHeight = 1624;
        private Vector2 _logScroll;
        private string _logText = string.Empty;

        private void OnEnable()
        {
            if (string.IsNullOrWhiteSpace(_htmlPath))
            {
                _htmlPath = EditorPrefs.GetString(LastHtmlPathEditorPrefKey, string.Empty);
            }

            _viewportWidth = Mathf.Max(
                1,
                EditorPrefs.GetInt(LastViewportWidthEditorPrefKey, _viewportWidth)
            );
            _viewportHeight = Mathf.Max(
                1,
                EditorPrefs.GetInt(LastViewportHeightEditorPrefKey, _viewportHeight)
            );
        }

        [MenuItem("Tools/Html To Prefab/Bake UI Resources")]
        public static void OpenWindow()
        {
            var window = GetWindow<HtmlBakeWindow>("HTML UI Baker");
            window.minSize = new Vector2(600f, 420f);
        }

        private void OnGUI()
        {
            DrawHtmlFileSection();
            EditorGUILayout.Space(8f);
            DrawTargetSection();
            EditorGUILayout.Space(8f);
            DrawOutputFolderSection();
            EditorGUILayout.Space(8f);
            DrawActionsSection();
            EditorGUILayout.Space(8f);
            DrawLogSection();
        }

        private void DrawHtmlFileSection()
        {
            EditorGUILayout.LabelField("HTML File", EditorStyles.boldLabel);

            using (new EditorGUILayout.HorizontalScope())
            {
                _htmlPath = EditorGUILayout.TextField("Path", _htmlPath);
                if (GUILayout.Button("Browse", GUILayout.Width(90f)))
                {
                    var selected = EditorUtility.OpenFilePanel("Select HTML file", "", "html,htm");
                    if (!string.IsNullOrEmpty(selected))
                    {
                        _htmlPath = selected;
                        Repaint();
                    }
                }
            }

            var dropRect = GUILayoutUtility.GetRect(0f, 56f, GUILayout.ExpandWidth(true));
            var dropLabel = string.IsNullOrEmpty(_htmlPath)
                ? "Drag HTML file here"
                : $"Drop target: {Path.GetFileName(_htmlPath)}";
            GUI.Box(dropRect, dropLabel, EditorStyles.helpBox);
            HandleDragAndDrop(dropRect);
        }

        private void DrawTargetSection()
        {
            EditorGUILayout.LabelField("Target Size", EditorStyles.boldLabel);
            _viewportWidth = EditorGUILayout.IntField("Target Width (Physical)", _viewportWidth);
            _viewportHeight = EditorGUILayout.IntField("Target Height (Physical)", _viewportHeight);
        }

        private void DrawOutputFolderSection()
        {
            EditorGUILayout.LabelField("Output Folder", EditorStyles.boldLabel);

            using (new EditorGUILayout.HorizontalScope())
            {
                _uiFolder = EditorGUILayout.TextField("Path", _uiFolder);
                if (GUILayout.Button("Browse", GUILayout.Width(90f)))
                {
                    var selected = EditorUtility.OpenFolderPanel("Select Output Folder", Application.dataPath, string.Empty);
                    if (!string.IsNullOrEmpty(selected))
                    {
                        if (TryAbsoluteToAssetPath(selected, out var assetPath))
                        {
                            _uiFolder = assetPath;
                            Repaint();
                        }
                        else
                        {
                            EditorUtility.DisplayDialog(
                                "Invalid Folder",
                                "Output folder must be inside this Unity project (under Assets).",
                                "OK"
                            );
                        }
                    }
                }
            }

            EditorGUILayout.HelpBox(
                "Use a folder under Assets/Resources (e.g. Assets/Resources/HtmlBake).",
                MessageType.Info
            );
        }

        private void DrawActionsSection()
        {
            if (!GUILayout.Button("Bake", GUILayout.Height(32f)))
            {
                return;
            }

            ExecuteBake();
        }

        private void DrawLogSection()
        {
            EditorGUILayout.LabelField("Log", EditorStyles.boldLabel);
            _logScroll = EditorGUILayout.BeginScrollView(_logScroll, GUILayout.ExpandHeight(true));
            EditorGUILayout.TextArea(string.IsNullOrEmpty(_logText) ? "No logs yet." : _logText, GUILayout.ExpandHeight(true));
            EditorGUILayout.EndScrollView();
        }

        private void ExecuteBake()
        {
            if (!IsHtmlFile(_htmlPath))
            {
                EditorUtility.DisplayDialog("Bake Failed", "Please select a valid .html/.htm file.", "OK");
                return;
            }

            var outputFolder = NormalizeAssetFolder(_uiFolder);
            if (!IsValidOutputFolder(outputFolder))
            {
                EditorUtility.DisplayDialog(
                    "Bake Failed",
                    "Output Folder must be inside Assets/Resources and cannot be Assets or Assets/Resources root.",
                    "OK"
                );
                return;
            }

            EnsureOutputFolderExists(outputFolder);

            BakeResult result;
            try
            {
                EditorUtility.DisplayProgressBar("HTML UI Baker", "Running bake pipeline...", 0.5f);
                result = BakePipeline.RunBake(
                    _htmlPath,
                    outputFolder,
                    Mathf.Max(1, _viewportWidth),
                    Mathf.Max(1, _viewportHeight)
                );
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }

            _logText = string.IsNullOrWhiteSpace(result.Log) ? result.Message : $"{result.Message}\n\n{result.Log}";
            Repaint();

            if (result.Success)
            {
                EditorPrefs.SetString(LastHtmlPathEditorPrefKey, _htmlPath);
                EditorPrefs.SetInt(LastViewportWidthEditorPrefKey, Mathf.Max(1, _viewportWidth));
                EditorPrefs.SetInt(LastViewportHeightEditorPrefKey, Mathf.Max(1, _viewportHeight));
                EditorUtility.DisplayDialog("Bake Success", result.Message, "OK");
            }
            else
            {
                EditorUtility.DisplayDialog("Bake Failed", result.Message, "OK");
            }
        }

        private static void EnsureOutputFolderExists(string assetFolderPath)
        {
            if (AssetDatabase.IsValidFolder(assetFolderPath))
            {
                return;
            }

            var absolutePath = AssetPathUtil.ToAbsolutePath(assetFolderPath);
            Directory.CreateDirectory(absolutePath);
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        }

        private void HandleDragAndDrop(Rect dropRect)
        {
            var evt = Event.current;
            if (!dropRect.Contains(evt.mousePosition))
            {
                return;
            }

            if (evt.type == EventType.DragUpdated)
            {
                DragAndDrop.visualMode = DragAndDropVisualMode.Copy;
                evt.Use();
            }
            else if (evt.type == EventType.DragPerform)
            {
                DragAndDrop.AcceptDrag();
                foreach (var path in DragAndDrop.paths)
                {
                    if (IsHtmlFile(path))
                    {
                        _htmlPath = path;
                        Repaint();
                        break;
                    }
                }

                evt.Use();
            }
        }

        private static bool TryAbsoluteToAssetPath(string absolutePath, out string assetPath)
        {
            assetPath = string.Empty;
            if (string.IsNullOrWhiteSpace(absolutePath)) return false;

            var projectRoot = Directory.GetParent(Application.dataPath)?.FullName;
            if (string.IsNullOrEmpty(projectRoot)) return false;

            var normalizedProjectRoot = projectRoot.Replace('\\', '/').TrimEnd('/');
            var normalizedAbsolute = absolutePath.Replace('\\', '/').TrimEnd('/');
            if (!normalizedAbsolute.StartsWith(normalizedProjectRoot, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            assetPath = normalizedAbsolute.Substring(normalizedProjectRoot.Length + 1);
            return assetPath.StartsWith("Assets", StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeAssetFolder(string assetPath)
        {
            var normalized = (assetPath ?? string.Empty).Trim().Replace('\\', '/');
            while (normalized.EndsWith("/", StringComparison.Ordinal))
            {
                normalized = normalized.Substring(0, normalized.Length - 1);
            }
            return normalized;
        }

        private static bool IsValidOutputFolder(string assetPath)
        {
            if (string.IsNullOrWhiteSpace(assetPath)) return false;
            if (!assetPath.StartsWith("Assets/Resources", StringComparison.OrdinalIgnoreCase)) return false;
            if (string.Equals(assetPath, "Assets", StringComparison.OrdinalIgnoreCase)) return false;
            if (string.Equals(assetPath, "Assets/Resources", StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }

        private static bool IsHtmlFile(string filePath)
        {
            if (string.IsNullOrWhiteSpace(filePath)) return false;
            if (!File.Exists(filePath)) return false;
            var ext = Path.GetExtension(filePath).ToLowerInvariant();
            return ext == ".html" || ext == ".htm";
        }
    }
}
