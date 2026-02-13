using System.IO;
using UnityEditor;
using UnityEngine;

namespace HtmlToPrefab.Editor
{
    public sealed class HtmlBakeWindow : EditorWindow
    {
        private enum NodeRuntimeMode
        {
            Auto,
            CustomPath
        }

        private enum RootSelectionMode
        {
            Auto,
            CustomSelector
        }

        private string _htmlPath = string.Empty;
        private string _nodeExecutable = string.Empty;
        private string _rootSelector = string.Empty;
        private NodeRuntimeMode _nodeRuntimeMode = NodeRuntimeMode.Auto;
        private RootSelectionMode _rootSelectionMode = RootSelectionMode.Auto;
        private bool _debug;
        private int _viewportWidth = 750;
        private int _viewportHeight = 1624;
        private float _deviceScaleFactor = 1f;
        private bool _showAdvanced;
        private Vector2 _logScroll;
        private string _logText = string.Empty;

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
            DrawOptionsSection();
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

        private void DrawOptionsSection()
        {
            EditorGUILayout.LabelField("Bake Options", EditorStyles.boldLabel);
            _debug = EditorGUILayout.Toggle("Debug Output", _debug);

            _showAdvanced = EditorGUILayout.Foldout(_showAdvanced, "Advanced Options", true);
            if (!_showAdvanced)
            {
                return;
            }

            EditorGUILayout.Space(2f);
            DrawRootSelectionOptions();
            EditorGUILayout.Space(4f);
            DrawNodeRuntimeOptions();
            EditorGUILayout.Space(4f);

            _viewportWidth = EditorGUILayout.IntField("Viewport Width", _viewportWidth);
            _viewportHeight = EditorGUILayout.IntField("Viewport Height", _viewportHeight);
            _deviceScaleFactor = EditorGUILayout.FloatField("Device Scale Factor", _deviceScaleFactor);
        }

        private void DrawRootSelectionOptions()
        {
            _rootSelectionMode = (RootSelectionMode)EditorGUILayout.EnumPopup("UI Root", _rootSelectionMode);
            if (_rootSelectionMode == RootSelectionMode.Auto)
            {
                EditorGUILayout.HelpBox(
                    "Auto mode detects the main UI container and crops to it automatically.",
                    MessageType.Info
                );
                return;
            }

            _rootSelector = EditorGUILayout.TextField("Root Selector", _rootSelector);
        }

        private void DrawNodeRuntimeOptions()
        {
            _nodeRuntimeMode = (NodeRuntimeMode)EditorGUILayout.EnumPopup("Node Runtime", _nodeRuntimeMode);
            if (_nodeRuntimeMode == NodeRuntimeMode.Auto)
            {
                EditorGUILayout.HelpBox(
                    "Auto mode uses `node` from system PATH. Switch to Custom Path if auto detection fails.",
                    MessageType.Info
                );
                return;
            }

            using (new EditorGUILayout.HorizontalScope())
            {
                _nodeExecutable = EditorGUILayout.TextField("Node Path", _nodeExecutable);
                if (GUILayout.Button("Browse", GUILayout.Width(90f)))
                {
                    var selected = EditorUtility.OpenFilePanel("Select Node Executable", "", "exe");
                    if (!string.IsNullOrEmpty(selected))
                    {
                        _nodeExecutable = selected;
                        Repaint();
                    }
                }
            }
        }

        private void DrawActionsSection()
        {
            if (!GUILayout.Button("Bake To Assets/Resources/UI", GUILayout.Height(32f)))
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

            var nodeExecutable = "node";
            if (_nodeRuntimeMode == NodeRuntimeMode.CustomPath)
            {
                if (string.IsNullOrWhiteSpace(_nodeExecutable) || !File.Exists(_nodeExecutable))
                {
                    EditorUtility.DisplayDialog("Bake Failed", "Please select a valid node executable path.", "OK");
                    return;
                }

                nodeExecutable = _nodeExecutable;
            }

            var rootSelector = "auto";
            if (_rootSelectionMode == RootSelectionMode.CustomSelector)
            {
                rootSelector = (_rootSelector ?? string.Empty).Trim();
                if (string.IsNullOrEmpty(rootSelector))
                {
                    EditorUtility.DisplayDialog("Bake Failed", "Root Selector cannot be empty in Custom mode.", "OK");
                    return;
                }
            }

            var request = new BakeRequest
            {
                HtmlAbsolutePath = _htmlPath,
                NodeExecutable = nodeExecutable,
                RootSelector = rootSelector,
                Debug = _debug,
                BakeRotation = false,
                StableIds = true,
                ViewportWidth = Mathf.Max(1, _viewportWidth),
                ViewportHeight = Mathf.Max(1, _viewportHeight),
                DeviceScaleFactor = Mathf.Max(0.01f, _deviceScaleFactor)
            };

            BakeResult result;
            try
            {
                EditorUtility.DisplayProgressBar("HTML UI Baker", "Running bake pipeline...", 0.5f);
                result = BakePipeline.Run(request);
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }

            _logText = string.IsNullOrWhiteSpace(result.Log) ? result.Message : $"{result.Message}\n\n{result.Log}";
            Repaint();

            if (result.Success)
            {
                EditorUtility.DisplayDialog("Bake Success", result.Message, "OK");
            }
            else
            {
                EditorUtility.DisplayDialog("Bake Failed", result.Message, "OK");
            }
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

        private static bool IsHtmlFile(string filePath)
        {
            if (string.IsNullOrWhiteSpace(filePath)) return false;
            if (!File.Exists(filePath)) return false;
            var ext = Path.GetExtension(filePath).ToLowerInvariant();
            return ext == ".html" || ext == ".htm";
        }
    }
}
