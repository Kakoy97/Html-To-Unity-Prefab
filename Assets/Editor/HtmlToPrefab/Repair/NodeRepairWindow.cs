using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using HtmlToPrefab.Runtime;
using UnityEditor;
using UnityEngine;

namespace HtmlToPrefab.Editor.Repair
{
    internal sealed class NodeRepairWindowContext
    {
        public int NodeInstanceId;
        public string NodeId = string.Empty;
        public string NodeType = string.Empty;
        public string HtmlTag = string.Empty;
        public string DomPath = string.Empty;
        public string HtmlPath = string.Empty;
        public string TargetImageAssetPath = string.Empty;
        public int TargetWidth = 750;
        public int TargetHeight = 1624;
    }

    internal sealed class VariantPreviewEntry
    {
        public RepairVariantPayload Variant;
        public Texture2D Texture;
        public string AbsoluteImagePath = string.Empty;
        public string LoadError = string.Empty;
    }

    internal enum EditingMode
    {
        SmartSelect = 0,
        ManualTuning = 1,
    }

    internal enum PendingRequestKind
    {
        None = 0,
        SmartGenerate = 1,
        ManualPreview = 2,
        ManualApply = 3,
    }

    public sealed class NodeRepairWindow : EditorWindow
    {
        private const float LeftPanelWidth = 340f;
        private const float SmartThumbnailWidth = 210f;
        private const float SmartThumbnailHeight = 130f;
        private const float ManualThumbnailWidth = 260f;
        private const float ManualThumbnailHeight = 130f;
        private const float VariantCardHeight = 300f;
        private const float VariantDescriptionHeight = 38f;

        private NodeRepairWindowContext _context = new NodeRepairWindowContext();
        private readonly List<VariantPreviewEntry> _previews = new List<VariantPreviewEntry>();

        private Vector2 _leftScroll;
        private Vector2 _rightScroll;
        private string _status = "Ready";
        private bool _autoRequested;

        private Task<RepairClientResponse> _pendingTask;
        private PendingRequestKind _pendingRequestKind = PendingRequestKind.None;

        private string _activePreviewVariantId = string.Empty;
        private Sprite _originalNodeSprite;
        private bool _hasOriginalSnapshot;
        private Sprite _activePreviewSprite;
        private Texture2D _activePreviewTexture;

        private EditingMode _editingMode = EditingMode.SmartSelect;
        private float _manualBrightness = 1f;
        private float _manualContrast = 1f;
        private float _manualSaturation = 1f;
        private bool _manualSliderDirty;
        private bool _manualPreviewQueued;
        private string _lastManualPreviewCss = string.Empty;
        private VariantPreviewEntry _manualPreviewEntry;

        [MenuItem("Tools/Html To Prefab/Node Repair Window")]
        public static void OpenWindow()
        {
            var window = GetWindow<NodeRepairWindow>("Node Repair");
            window.minSize = new Vector2(980f, 640f);
        }

        public static void OpenForNode(UiNodeRef nodeRef, string htmlPath, string targetImageAssetPath)
        {
            var window = GetWindow<NodeRepairWindow>("Node Repair");
            window.minSize = new Vector2(980f, 640f);
            window.ResetState(nodeRef, htmlPath, targetImageAssetPath);
            window.Show();
            window.Focus();
        }

        private void OnEnable()
        {
            if (string.IsNullOrWhiteSpace(_context.HtmlPath))
            {
                _context.HtmlPath = EditorPrefs.GetString(HtmlBakeWindow.LastHtmlPathEditorPrefKey, string.Empty);
            }

            if (_context.TargetWidth <= 0)
            {
                _context.TargetWidth = Mathf.Max(1, EditorPrefs.GetInt(HtmlBakeWindow.LastViewportWidthEditorPrefKey, 750));
            }
            if (_context.TargetHeight <= 0)
            {
                _context.TargetHeight = Mathf.Max(1, EditorPrefs.GetInt(HtmlBakeWindow.LastViewportHeightEditorPrefKey, 1624));
            }
        }

        private void OnDisable()
        {
            RestoreOriginalPreview();
            ReleaseActivePreviewAssets();
            ReleasePreviews();
            ReleaseManualPreview(true);
        }

        private void Update()
        {
            if (_pendingTask != null && _pendingTask.IsCompleted)
            {
                var task = _pendingTask;
                var kind = _pendingRequestKind;
                _pendingTask = null;
                _pendingRequestKind = PendingRequestKind.None;
                HandleTaskCompleted(task, kind);

                if (_manualPreviewQueued && _editingMode == EditingMode.ManualTuning)
                {
                    _manualPreviewQueued = false;
                    StartManualPreview(true);
                }

                Repaint();
            }

            if (!_autoRequested && _pendingTask == null && IsContextReadyForAutoRun())
            {
                _autoRequested = true;
                StartSmartRepair();
            }
        }

        private void OnGUI()
        {
            DrawToolbar();
            EditorGUILayout.Space(6f);
            using (new EditorGUILayout.VerticalScope())
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    DrawLeftPanel();
                    DrawRightPanel();
                }

                EditorGUILayout.Space(8f);
                DrawManualAdjustmentPanel();
            }
        }

        private void DrawToolbar()
        {
            using (new EditorGUILayout.HorizontalScope(EditorStyles.toolbar))
            {
                GUILayout.Label("Repair Pipeline", EditorStyles.miniBoldLabel);
                GUILayout.FlexibleSpace();
                using (new EditorGUI.DisabledScope(_pendingTask != null))
                {
                    if (GUILayout.Button("Re-Diagnose", EditorStyles.toolbarButton, GUILayout.Width(100f)))
                    {
                        StartSmartRepair();
                    }
                }
                using (new EditorGUI.DisabledScope(string.IsNullOrEmpty(_activePreviewVariantId)))
                {
                    if (GUILayout.Button("Restore", EditorStyles.toolbarButton, GUILayout.Width(70f)))
                    {
                        RestoreOriginalPreview();
                        ReleaseActivePreviewAssets();
                    }
                }
            }
        }

        private void DrawLeftPanel()
        {
            using (new EditorGUILayout.VerticalScope(GUILayout.Width(LeftPanelWidth)))
            {
                _leftScroll = EditorGUILayout.BeginScrollView(_leftScroll);
                DrawNodeInfo();
                DrawPathInfo();
                DrawTargetInfo();
                DrawLeftActions();
                EditorGUILayout.HelpBox(_status, MessageType.None);
                EditorGUILayout.EndScrollView();
            }
        }

        private void DrawRightPanel()
        {
            using (new EditorGUILayout.VerticalScope(GUILayout.ExpandWidth(true), GUILayout.ExpandHeight(true)))
            {
                EditorGUILayout.LabelField("Repair Variants", EditorStyles.boldLabel);
                EditorGUILayout.Space(4f);

                if (_pendingTask != null && _pendingRequestKind == PendingRequestKind.SmartGenerate)
                {
                    EditorGUILayout.HelpBox("Generating repair variants...", MessageType.Info);
                    var rect = GUILayoutUtility.GetRect(10f, 18f, GUILayout.ExpandWidth(true));
                    EditorGUI.ProgressBar(rect, 0.6f, "Smart Generation Running");
                    return;
                }

                if (_previews.Count == 0)
                {
                    EditorGUILayout.HelpBox("No smart preview yet.", MessageType.Info);
                    return;
                }

                _rightScroll = EditorGUILayout.BeginScrollView(_rightScroll);
                using (new EditorGUILayout.HorizontalScope())
                {
                    var totalWidth = Mathf.Max(480f, position.width - LeftPanelWidth - 40f);
                    var cardWidth = Mathf.Max(220f, (totalWidth - 18f) / 3f);
                    for (var i = 0; i < _previews.Count; i++)
                    {
                        DrawVariantCard(_previews[i], cardWidth);
                        if (i < _previews.Count - 1)
                        {
                            GUILayout.Space(6f);
                        }
                    }
                }
                EditorGUILayout.EndScrollView();
            }
        }

        private void ResetState(UiNodeRef nodeRef, string htmlPath, string targetImageAssetPath)
        {
            RestoreOriginalPreview();
            ReleaseActivePreviewAssets();
            ReleasePreviews();
            ReleaseManualPreview(true);

            var rememberedWidth = EditorPrefs.GetInt(HtmlBakeWindow.LastViewportWidthEditorPrefKey, 750);
            var rememberedHeight = EditorPrefs.GetInt(HtmlBakeWindow.LastViewportHeightEditorPrefKey, 1624);

            _context = new NodeRepairWindowContext
            {
                NodeInstanceId = nodeRef != null ? nodeRef.GetInstanceID() : 0,
                NodeId = nodeRef != null ? nodeRef.NodeId : string.Empty,
                NodeType = nodeRef != null ? nodeRef.NodeType : string.Empty,
                HtmlTag = nodeRef != null ? nodeRef.HtmlTag : string.Empty,
                DomPath = nodeRef != null ? nodeRef.DomPath : string.Empty,
                HtmlPath = htmlPath ?? string.Empty,
                TargetImageAssetPath = targetImageAssetPath ?? string.Empty,
                TargetWidth = Mathf.Max(1, rememberedWidth),
                TargetHeight = Mathf.Max(1, rememberedHeight),
            };

            _status = "Ready";
            _autoRequested = false;
            _pendingTask = null;
            _pendingRequestKind = PendingRequestKind.None;
            _activePreviewVariantId = string.Empty;
            _originalNodeSprite = null;
            _hasOriginalSnapshot = false;
            _editingMode = EditingMode.SmartSelect;
            _manualBrightness = 1f;
            _manualContrast = 1f;
            _manualSaturation = 1f;
            _manualSliderDirty = false;
            _manualPreviewQueued = false;
            _lastManualPreviewCss = string.Empty;
        }

        private void DrawNodeInfo()
        {
            EditorGUILayout.LabelField("Selected Node", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Node ID", string.IsNullOrEmpty(_context.NodeId) ? "-" : _context.NodeId);
            EditorGUILayout.LabelField("Node Type", string.IsNullOrEmpty(_context.NodeType) ? "-" : _context.NodeType);
            EditorGUILayout.LabelField("HTML Tag", string.IsNullOrEmpty(_context.HtmlTag) ? "-" : _context.HtmlTag);
            EditorGUILayout.LabelField("DOM Path", string.IsNullOrEmpty(_context.DomPath) ? "-" : _context.DomPath);
            EditorGUILayout.Space(8f);
        }

        private void DrawPathInfo()
        {
            EditorGUILayout.LabelField("HTML Path", EditorStyles.boldLabel);
            _context.HtmlPath = EditorGUILayout.TextField(_context.HtmlPath);
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Browse HTML", GUILayout.Width(100f)))
                {
                    var selected = EditorUtility.OpenFilePanel("Select HTML", "", "html,htm");
                    if (!string.IsNullOrWhiteSpace(selected))
                    {
                        _context.HtmlPath = selected;
                    }
                }
                GUILayout.FlexibleSpace();
            }

            if (!string.IsNullOrWhiteSpace(_context.HtmlPath) && !File.Exists(_context.HtmlPath))
            {
                EditorGUILayout.HelpBox("HTML file does not exist.", MessageType.Warning);
            }
            EditorGUILayout.Space(8f);
        }

        private void DrawTargetInfo()
        {
            EditorGUILayout.LabelField("Target Resolution", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Width", _context.TargetWidth.ToString());
            EditorGUILayout.LabelField("Height", _context.TargetHeight.ToString());

            EditorGUILayout.Space(8f);
            EditorGUILayout.LabelField("Target Sprite Asset", EditorStyles.boldLabel);
            EditorGUILayout.SelectableLabel(
                string.IsNullOrWhiteSpace(_context.TargetImageAssetPath) ? "(Image/Sprite not found)" : _context.TargetImageAssetPath,
                EditorStyles.textField,
                GUILayout.Height(38f)
            );

            if (string.IsNullOrWhiteSpace(_context.TargetImageAssetPath))
            {
                EditorGUILayout.HelpBox("No sprite found on current node. Apply step will be unavailable.", MessageType.Info);
            }
            EditorGUILayout.Space(12f);
        }

        private void DrawLeftActions()
        {
            using (new EditorGUI.DisabledScope(_pendingTask != null || string.IsNullOrWhiteSpace(_context.NodeId)))
            {
                if (GUILayout.Button("Smart Diagnose", GUILayout.Height(36f)))
                {
                    StartSmartRepair();
                }
            }

            EditorGUILayout.Space(8f);
            if (!string.IsNullOrEmpty(_activePreviewVariantId))
            {
                EditorGUILayout.HelpBox($"Previewing: {_activePreviewVariantId}", MessageType.Info);
            }
        }

        private bool IsContextReadyForAutoRun()
        {
            return !string.IsNullOrWhiteSpace(_context.NodeId) &&
                   !string.IsNullOrWhiteSpace(_context.HtmlPath) &&
                   File.Exists(_context.HtmlPath);
        }

        private RepairManualParams BuildBaseManualParams()
        {
            return new RepairManualParams
            {
                width = Mathf.Max(1, _context.TargetWidth),
                height = Mathf.Max(1, _context.TargetHeight),
                nodeType = _context.NodeType ?? string.Empty,
                domPath = _context.DomPath ?? string.Empty,
                stripText = true,
                isolateNode = true,
                hideOwnText = true,
                hideChildren = !string.Equals(_context.NodeType, "Text", StringComparison.OrdinalIgnoreCase),
            };
        }

        private RepairManualParams BuildColorManualParams(string cssFilter)
        {
            var manual = BuildBaseManualParams();
            manual.strategy = "COLOR_CORRECTION";
            manual.colorFilter = cssFilter ?? string.Empty;
            manual.cssFilter = cssFilter ?? string.Empty;
            return manual;
        }

        private static string GenerateCssFilter(float brightness, float contrast, float saturation)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "brightness({0:0.###}) contrast({1:0.###}) saturate({2:0.###})",
                brightness,
                contrast,
                saturation
            );
        }

        private void DrawManualAdjustmentPanel()
        {
            using (new EditorGUILayout.VerticalScope("box"))
            {
                EditorGUILayout.LabelField("Manual Color Adjustment", EditorStyles.boldLabel);
                var requestedMode = (EditingMode)GUILayout.Toolbar(
                    (int)_editingMode,
                    new[] { "Smart Select", "Manual Tuning" }
                );
                if (requestedMode != _editingMode)
                {
                    _editingMode = requestedMode;
                }

                if (_editingMode != EditingMode.ManualTuning)
                {
                    EditorGUILayout.HelpBox("Switch to Manual Tuning to adjust color.", MessageType.Info);
                    return;
                }

                if (!IsContextReadyForAutoRun())
                {
                    EditorGUILayout.HelpBox("Manual tuning requires valid node/html path.", MessageType.Warning);
                    return;
                }

                EditorGUI.BeginChangeCheck();
                _manualBrightness = EditorGUILayout.Slider("Brightness", _manualBrightness, 0.5f, 1.5f);
                _manualContrast = EditorGUILayout.Slider("Contrast", _manualContrast, 0.5f, 1.5f);
                _manualSaturation = EditorGUILayout.Slider("Saturation", _manualSaturation, 0f, 2f);
                if (EditorGUI.EndChangeCheck())
                {
                    _manualBrightness = Mathf.Clamp(_manualBrightness, 0.5f, 1.5f);
                    _manualContrast = Mathf.Clamp(_manualContrast, 0.5f, 1.5f);
                    _manualSaturation = Mathf.Clamp(_manualSaturation, 0f, 2f);
                    _manualSliderDirty = true;
                }

                using (new EditorGUILayout.HorizontalScope())
                {
                    using (new EditorGUI.DisabledScope(_pendingTask != null))
                    {
                        if (GUILayout.Button("Darker", GUILayout.Height(26f)))
                        {
                            _manualBrightness = Mathf.Clamp(_manualBrightness - 0.1f, 0.5f, 1.5f);
                            _manualContrast = Mathf.Clamp(_manualContrast + 0.1f, 0.5f, 1.5f);
                            _manualSliderDirty = false;
                            StartManualPreview(true);
                        }
                        if (GUILayout.Button("Lighter", GUILayout.Height(26f)))
                        {
                            _manualBrightness = Mathf.Clamp(_manualBrightness + 0.1f, 0.5f, 1.5f);
                            _manualSliderDirty = false;
                            StartManualPreview(true);
                        }
                        if (GUILayout.Button("Reset", GUILayout.Height(26f)))
                        {
                            _manualBrightness = 1f;
                            _manualContrast = 1f;
                            _manualSaturation = 1f;
                            _manualSliderDirty = false;
                            StartManualPreview(true);
                        }
                        if (GUILayout.Button("Generate Preview", GUILayout.Height(26f)))
                        {
                            _manualSliderDirty = false;
                            StartManualPreview(true);
                        }
                    }
                }

                var css = GenerateCssFilter(_manualBrightness, _manualContrast, _manualSaturation);
                EditorGUILayout.LabelField("CSS Filter", css, EditorStyles.wordWrappedMiniLabel);

                if (_manualSliderDirty && Event.current != null && Event.current.type == EventType.MouseUp)
                {
                    _manualSliderDirty = false;
                    StartManualPreview(true);
                }

                DrawManualPreviewArea();

                using (new EditorGUI.DisabledScope(
                           _pendingTask != null ||
                           string.IsNullOrWhiteSpace(_context.TargetImageAssetPath)))
                {
                    if (GUILayout.Button("Apply Adjustments", GUILayout.Height(34f)))
                    {
                        StartManualApply();
                    }
                }
            }
        }

        private void DrawVariantCard(VariantPreviewEntry entry, float width)
        {
            using (new EditorGUILayout.VerticalScope("box", GUILayout.Width(width), GUILayout.Height(VariantCardHeight)))
            {
                var variantName = entry != null && entry.Variant != null ? entry.Variant.name : "(Unnamed)";
                EditorGUILayout.LabelField(variantName, EditorStyles.boldLabel);
                EditorGUILayout.Space(2f);

                if (entry != null && entry.Texture != null)
                {
                    var thumbnailWidth = Mathf.Clamp(width - 18f, 120f, SmartThumbnailWidth);
                    DrawFixedThumbnail(entry.Texture, thumbnailWidth, SmartThumbnailHeight);
                }
                else
                {
                    EditorGUILayout.HelpBox(
                        string.IsNullOrWhiteSpace(entry != null ? entry.LoadError : string.Empty)
                            ? "Preview texture load failed."
                            : entry.LoadError,
                        MessageType.Warning
                    );
                }

                var desc = entry != null && entry.Variant != null ? entry.Variant.description : string.Empty;
                if (!string.IsNullOrWhiteSpace(desc))
                {
                    EditorGUILayout.LabelField(
                        desc,
                        EditorStyles.wordWrappedMiniLabel,
                        GUILayout.Height(VariantDescriptionHeight)
                    );
                }
                else
                {
                    GUILayout.Space(VariantDescriptionHeight);
                }

                GUILayout.FlexibleSpace();
                using (new EditorGUI.DisabledScope(
                           entry == null ||
                           entry.Texture == null))
                {
                    if (GUILayout.Button("Preview On Node", GUILayout.Height(32f)))
                    {
                        PreviewVariant(entry);
                    }
                }

                using (new EditorGUI.DisabledScope(
                           entry == null ||
                           entry.Texture == null ||
                           string.IsNullOrWhiteSpace(_context.TargetImageAssetPath) ||
                           _pendingTask != null))
                {
                    if (GUILayout.Button("Apply This Variant", GUILayout.Height(36f)))
                    {
                        ApplyVariant(entry);
                    }
                }
            }
        }

        private void StartSmartRepair()
        {
            if (!IsContextReadyForAutoRun())
            {
                _status = "Cannot diagnose: invalid node/html path.";
                return;
            }

            EditorPrefs.SetString(HtmlBakeWindow.LastHtmlPathEditorPrefKey, _context.HtmlPath);
            RestoreOriginalPreview();
            ReleaseActivePreviewAssets();
            _activePreviewVariantId = string.Empty;
            _originalNodeSprite = null;
            _hasOriginalSnapshot = false;
            ReleasePreviews();
            ReleaseManualPreview(true);
            _manualPreviewQueued = false;
            _status = "Calling Node Repair Pipeline...";

            _pendingRequestKind = PendingRequestKind.SmartGenerate;
            _pendingTask = RepairClient.RunSmartGenerateAsync(
                _context.NodeId,
                _context.HtmlPath,
                BuildBaseManualParams(),
                true
            );
        }

        private void StartManualPreview(bool force)
        {
            if (!IsContextReadyForAutoRun())
            {
                _status = "Manual preview failed: invalid node/html path.";
                return;
            }

            var css = GenerateCssFilter(_manualBrightness, _manualContrast, _manualSaturation);
            if (!force &&
                _manualPreviewEntry != null &&
                string.Equals(css, _lastManualPreviewCss, StringComparison.Ordinal))
            {
                return;
            }

            if (_pendingTask != null)
            {
                _manualPreviewQueued = true;
                return;
            }

            _manualPreviewQueued = false;
            _lastManualPreviewCss = css;
            _status = $"Generating manual preview: {css}";

            _pendingRequestKind = PendingRequestKind.ManualPreview;
            _pendingTask = RepairClient.RunManualAsync(
                _context.NodeId,
                _context.HtmlPath,
                BuildColorManualParams(css),
                true
            );
        }

        private void StartManualApply()
        {
            if (string.IsNullOrWhiteSpace(_context.TargetImageAssetPath))
            {
                EditorUtility.DisplayDialog("Apply Failed", "Target image asset path is empty.", "OK");
                return;
            }

            if (!IsContextReadyForAutoRun())
            {
                EditorUtility.DisplayDialog("Apply Failed", "NodeId/htmlPath is invalid.", "OK");
                return;
            }

            if (_pendingTask != null)
            {
                _manualPreviewQueued = true;
                return;
            }

            var css = GenerateCssFilter(_manualBrightness, _manualContrast, _manualSaturation);
            _status = $"Applying manual adjustment: {css}";
            _pendingRequestKind = PendingRequestKind.ManualApply;
            _pendingTask = RepairClient.RunManualAsync(
                _context.NodeId,
                _context.HtmlPath,
                BuildColorManualParams(css),
                false
            );
        }

        private void HandleTaskCompleted(Task<RepairClientResponse> task, PendingRequestKind kind)
        {
            if (!TryGetTaskResponse(task, out var response, out var error))
            {
                _status = error;
                if (kind == PendingRequestKind.ManualApply)
                {
                    EditorUtility.DisplayDialog("Apply Failed", error, "OK");
                }
                return;
            }

            if (kind == PendingRequestKind.SmartGenerate)
            {
                BuildPreviews(response.Result);
                _status = $"Generated {response.Result.variants.Count} variant(s).";
                return;
            }

            if (kind == PendingRequestKind.ManualPreview)
            {
                HandleManualPreviewResponse(response.Result);
                return;
            }

            if (kind == PendingRequestKind.ManualApply)
            {
                HandleManualApplyResponse(response.Result);
            }
        }

        private void DrawManualPreviewArea()
        {
            if (_manualPreviewEntry == null)
            {
                EditorGUILayout.HelpBox("Drag sliders and release mouse to generate preview.", MessageType.Info);
                return;
            }

            if (_manualPreviewEntry.Texture == null)
            {
                EditorGUILayout.HelpBox(
                    string.IsNullOrWhiteSpace(_manualPreviewEntry.LoadError)
                        ? "Manual preview texture is not available."
                        : _manualPreviewEntry.LoadError,
                    MessageType.Warning
                );
                return;
            }

            var maxWidth = Mathf.Max(140f, position.width - 80f);
            var thumbnailWidth = Mathf.Clamp(maxWidth, 140f, ManualThumbnailWidth);
            DrawFixedThumbnail(_manualPreviewEntry.Texture, thumbnailWidth, ManualThumbnailHeight);

            var desc = _manualPreviewEntry.Variant != null ? _manualPreviewEntry.Variant.description : string.Empty;
            if (!string.IsNullOrWhiteSpace(desc))
            {
                EditorGUILayout.LabelField(desc, EditorStyles.wordWrappedMiniLabel);
            }

            using (new EditorGUI.DisabledScope(_pendingTask != null))
            {
                if (GUILayout.Button("Preview Manual Result On Node", GUILayout.Height(26f)))
                {
                    PreviewVariant(_manualPreviewEntry);
                }
            }
        }

        private static void DrawFixedThumbnail(Texture2D texture, float width, float height)
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.FlexibleSpace();
                var rect = GUILayoutUtility.GetRect(
                    width,
                    height,
                    GUILayout.Width(width),
                    GUILayout.Height(height)
                );
                EditorGUI.DrawRect(rect, new Color(0.14f, 0.14f, 0.14f, 1f));
                GUI.DrawTexture(rect, texture, ScaleMode.ScaleToFit, true);
                GUILayout.FlexibleSpace();
            }
        }

        private static bool TryGetTaskResponse(
            Task<RepairClientResponse> task,
            out RepairClientResponse response,
            out string error
        )
        {
            response = null;
            error = string.Empty;
            try
            {
                response = task.Result;
            }
            catch (Exception ex)
            {
                error = $"Repair failed: {ex.Message}";
                return false;
            }

            if (response == null)
            {
                error = "Repair failed: empty response.";
                return false;
            }

            if (!response.Success || response.Result == null)
            {
                var details = string.IsNullOrWhiteSpace(response.StdErr) ? response.StdOut : response.StdErr;
                error = $"Repair failed: {response.Message}\n{details}";
                return false;
            }

            return true;
        }

        private void HandleManualPreviewResponse(RepairResultPayload payload)
        {
            var selected = PickColorVariant(payload);
            if (selected == null)
            {
                DeleteVariantTempFiles(payload, string.Empty);
                _status = "Manual preview failed: color variant is missing.";
                return;
            }

            if (!TryBuildPreviewEntry(selected, out var entry, out var loadError))
            {
                DeleteVariantTempFiles(payload, string.Empty);
                _status = $"Manual preview failed: {loadError}";
                return;
            }

            ReleaseManualPreview(true);
            _manualPreviewEntry = entry;
            DeleteVariantTempFiles(payload, selected.imagePath);
            _status = $"Manual preview updated ({GenerateCssFilter(_manualBrightness, _manualContrast, _manualSaturation)}).";
        }

        private void HandleManualApplyResponse(RepairResultPayload payload)
        {
            var selected = PickColorVariant(payload);
            if (selected == null)
            {
                DeleteVariantTempFiles(payload, string.Empty);
                EditorUtility.DisplayDialog("Apply Failed", "Manual apply result has no color variant.", "OK");
                _status = "Manual apply failed: no color variant.";
                return;
            }

            if (!TryBuildPreviewEntry(selected, out var entry, out var loadError))
            {
                DeleteVariantTempFiles(payload, string.Empty);
                EditorUtility.DisplayDialog("Apply Failed", loadError, "OK");
                _status = $"Manual apply failed: {loadError}";
                return;
            }

            var applied = TryApplyVariantCore(entry, out var applyError);
            RepairTextureUtil.ReleaseTexture(entry.Texture);
            DeleteVariantTempFiles(payload, string.Empty);

            if (!applied)
            {
                EditorUtility.DisplayDialog("Apply Failed", applyError, "OK");
                _status = $"Manual apply failed: {applyError}";
                return;
            }

            DeleteAllVariantTempFiles();
            ReleaseManualPreview(true);
            _activePreviewVariantId = string.Empty;
            _originalNodeSprite = null;
            _hasOriginalSnapshot = false;
            ReleaseActivePreviewAssets();

            var css = GenerateCssFilter(_manualBrightness, _manualContrast, _manualSaturation);
            Debug.Log($"Node [{_context.NodeId}] repaired with manual color filter [{css}]");
            Close();
        }

        private static RepairVariantPayload PickColorVariant(RepairResultPayload payload)
        {
            if (payload == null || payload.variants == null || payload.variants.Count == 0)
            {
                return null;
            }

            for (var i = 0; i < payload.variants.Count; i++)
            {
                var item = payload.variants[i];
                if (item == null) continue;
                if (string.Equals(item.id, "variant_color_auto", StringComparison.OrdinalIgnoreCase))
                {
                    return item;
                }
            }

            return payload.variants[0];
        }

        private bool TryBuildPreviewEntry(RepairVariantPayload variant, out VariantPreviewEntry entry, out string error)
        {
            entry = null;
            error = string.Empty;
            if (variant == null)
            {
                error = "Variant is null.";
                return false;
            }

            if (!RepairTextureUtil.TryLoadPreviewTexture(
                    variant.imagePath,
                    out var texture,
                    out var absolutePath,
                    out var loadError))
            {
                error = loadError;
                return false;
            }

            entry = new VariantPreviewEntry
            {
                Variant = variant,
                Texture = texture,
                AbsoluteImagePath = absolutePath,
                LoadError = string.Empty,
            };
            return true;
        }

        private void BuildPreviews(RepairResultPayload payload)
        {
            RestoreOriginalPreview();
            ReleaseActivePreviewAssets();
            _activePreviewVariantId = string.Empty;
            _originalNodeSprite = null;
            _hasOriginalSnapshot = false;
            ReleasePreviews();

            if (payload == null || payload.variants == null)
            {
                return;
            }

            for (var i = 0; i < payload.variants.Count; i++)
            {
                var variant = payload.variants[i];
                if (variant == null) continue;
                var entry = new VariantPreviewEntry
                {
                    Variant = variant
                };

                if (RepairTextureUtil.TryLoadPreviewTexture(
                        variant.imagePath,
                        out var texture,
                        out var absolutePath,
                        out var error))
                {
                    entry.Texture = texture;
                    entry.AbsoluteImagePath = absolutePath;
                }
                else
                {
                    entry.LoadError = error;
                }

                _previews.Add(entry);
            }
        }

        private void ReleasePreviews()
        {
            for (var i = 0; i < _previews.Count; i++)
            {
                if (_previews[i] == null) continue;
                RepairTextureUtil.ReleaseTexture(_previews[i].Texture);
            }
            _previews.Clear();
        }

        private void ReleaseManualPreview(bool deleteTempFile)
        {
            if (_manualPreviewEntry == null)
            {
                return;
            }

            RepairTextureUtil.ReleaseTexture(_manualPreviewEntry.Texture);
            if (deleteTempFile && !string.IsNullOrWhiteSpace(_manualPreviewEntry.AbsoluteImagePath))
            {
                RepairTextureUtil.DeleteFileQuietly(_manualPreviewEntry.AbsoluteImagePath);
            }
            _manualPreviewEntry = null;
        }

        private void DeleteVariantTempFiles(RepairResultPayload payload, string keepImagePath)
        {
            if (payload == null || payload.variants == null)
            {
                return;
            }

            var keep = string.IsNullOrWhiteSpace(keepImagePath) ? string.Empty : keepImagePath.Trim();
            for (var i = 0; i < payload.variants.Count; i++)
            {
                var variant = payload.variants[i];
                if (variant == null || string.IsNullOrWhiteSpace(variant.imagePath)) continue;
                if (!string.IsNullOrEmpty(keep) &&
                    string.Equals(variant.imagePath.Trim(), keep, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                RepairTextureUtil.DeleteFileQuietly(ResolveAbsolutePath(variant.imagePath));
            }
        }

        private static string ResolveAbsolutePath(string imagePath)
        {
            if (string.IsNullOrWhiteSpace(imagePath)) return string.Empty;
            if (Path.IsPathRooted(imagePath)) return imagePath;
            var projectRoot = Directory.GetParent(Application.dataPath)?.FullName ?? string.Empty;
            return Path.GetFullPath(Path.Combine(projectRoot, imagePath));
        }

        private void ApplyVariant(VariantPreviewEntry entry)
        {
            if (entry == null || entry.Variant == null)
            {
                EditorUtility.DisplayDialog("Apply Failed", "Variant is invalid.", "OK");
                return;
            }

            if (!TryApplyVariantCore(entry, out var error))
            {
                EditorUtility.DisplayDialog("Apply Failed", error, "OK");
                return;
            }

            DeleteAllVariantTempFiles();
            ReleaseManualPreview(true);
            _activePreviewVariantId = string.Empty;
            _originalNodeSprite = null;
            _hasOriginalSnapshot = false;
            ReleaseActivePreviewAssets();
            Debug.Log($"Node [{_context.NodeId}] repaired with strategy [{entry.Variant.name}]");
            Close();
        }

        private bool TryApplyVariantCore(VariantPreviewEntry entry, out string error)
        {
            error = string.Empty;
            if (entry == null || entry.Variant == null)
            {
                error = "Variant is invalid.";
                return false;
            }

            if (string.IsNullOrWhiteSpace(_context.TargetImageAssetPath))
            {
                error = "Target image asset path is empty.";
                return false;
            }

            if (!RepairTextureUtil.ApplyVariantImage(entry.AbsoluteImagePath, _context.TargetImageAssetPath, out error))
            {
                return false;
            }

            if (!RepairTextureUtil.TryBindImportedSprite(_context.NodeInstanceId, _context.TargetImageAssetPath, out var bindError))
            {
                Debug.LogWarning($"Bind imported sprite warning: {bindError}");
            }

            var adjusted = RepairTextureUtil.TryApplyMetadataOffset(
                _context.NodeInstanceId,
                entry.Variant.metadata,
                _context.TargetImageAssetPath,
                out var metadataMessage
            );
            if (!string.IsNullOrWhiteSpace(metadataMessage))
            {
                if (adjusted) Debug.Log(metadataMessage);
                else Debug.LogWarning(metadataMessage);
            }

            return true;
        }

        private void PreviewVariant(VariantPreviewEntry entry)
        {
            if (entry == null || entry.Variant == null)
            {
                _status = "Preview failed: invalid variant.";
                return;
            }

            if (string.IsNullOrWhiteSpace(entry.AbsoluteImagePath) || !File.Exists(entry.AbsoluteImagePath))
            {
                _status = "Preview failed: temporary image file missing.";
                return;
            }

            if (!RepairTextureUtil.TryGetTargetImage(_context.NodeInstanceId, out var targetImage, out var imageError))
            {
                _status = $"Preview failed: {imageError}";
                return;
            }

            if (!_hasOriginalSnapshot)
            {
                _originalNodeSprite = targetImage.sprite;
                _hasOriginalSnapshot = true;
            }

            ReleaseActivePreviewAssets();
            var pixelsPerUnit = targetImage != null && targetImage.sprite != null
                ? targetImage.sprite.pixelsPerUnit
                : 100f;
            if (!RepairTextureUtil.TryCreatePreviewSprite(
                    entry.AbsoluteImagePath,
                    out _activePreviewTexture,
                    out _activePreviewSprite,
                    out var createError,
                    pixelsPerUnit))
            {
                _status = $"Preview failed: {createError}";
                return;
            }

            if (!RepairTextureUtil.TryAssignPreviewSprite(_context.NodeInstanceId, _activePreviewSprite, out var assignError))
            {
                ReleaseActivePreviewAssets();
                _status = $"Preview failed: {assignError}";
                return;
            }

            _activePreviewVariantId = entry.Variant.id ?? string.Empty;
            _status = $"Previewing [{entry.Variant.name}]";
        }

        private void RestoreOriginalPreview()
        {
            if (!_hasOriginalSnapshot)
            {
                _activePreviewVariantId = string.Empty;
                return;
            }

            if (!RepairTextureUtil.TryRestoreOriginalSprite(_context.NodeInstanceId, _originalNodeSprite, out var error))
            {
                Debug.LogWarning($"Restore original preview failed: {error}");
            }
            _activePreviewVariantId = string.Empty;
        }

        private void ReleaseActivePreviewAssets()
        {
            if (_activePreviewSprite != null)
            {
                RepairTextureUtil.ReleaseSprite(_activePreviewSprite);
                _activePreviewSprite = null;
            }

            if (_activePreviewTexture != null)
            {
                RepairTextureUtil.ReleaseTexture(_activePreviewTexture);
                _activePreviewTexture = null;
            }
        }

        private void DeleteAllVariantTempFiles()
        {
            for (var i = 0; i < _previews.Count; i++)
            {
                var item = _previews[i];
                if (item == null || string.IsNullOrWhiteSpace(item.AbsoluteImagePath)) continue;
                RepairTextureUtil.DeleteFileQuietly(item.AbsoluteImagePath);
            }
        }
    }
}

