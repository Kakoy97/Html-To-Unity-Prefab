using System;
using System.Collections.Generic;
using System.Globalization;
using HtmlToPrefab.Runtime;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace HtmlToPrefab.Editor
{
    internal static class PrefabBuilder
    {
        public static string Build(
            LayoutNode root,
            string htmlName,
            string uiFolderAssetPath,
            int targetWidth,
            int targetHeight
        )
        {
            if (root == null) throw new ArgumentNullException(nameof(root));

            var prefabDir = $"Assets/Resources/Prefab/{htmlName}".Replace('\\', '/');
            EnsureFolder("Assets/Resources", "Prefab");
            EnsureFolder("Assets/Resources/Prefab", htmlName);

            var rootGo = new GameObject(htmlName, typeof(RectTransform));
            try
            {
                // Prefer the layout root physical size; targetWidth/targetHeight are fallback only.

                var finalWidth = (root.rect != null && root.rect.width > 0f)
                    ? root.rect.width
                    : Mathf.Max(1f, targetWidth);
                var finalHeight = (root.rect != null && root.rect.height > 0f)
                    ? root.rect.height
                    : Mathf.Max(1f, targetHeight);

                var outputRootRect = new LayoutRect
                {
                    x = 0f,
                    y = 0f,
                    width = finalWidth,
                    height = finalHeight,
                };
                var rootRt = rootGo.GetComponent<RectTransform>();
                ConfigureRect(rootRt, null, outputRootRect, outputRootRect);

                // Create content container that uses root physical coordinates directly.
                var contentGo = new GameObject("__content", typeof(RectTransform));
                var contentRt = contentGo.GetComponent<RectTransform>();
                contentRt.SetParent(rootRt, false);

                // 涓嶅啀闇€瑕佺缉鏀捐绠楋紝鐩存帴浣跨敤鐗╃悊鍧愭爣
                var sourceRootRect = root.rect ?? outputRootRect;
                contentRt.anchorMin = new Vector2(0f, 1f);
                contentRt.anchorMax = new Vector2(0f, 1f);
                contentRt.pivot = new Vector2(0f, 1f);
                contentRt.sizeDelta = new Vector2(sourceRootRect.width, sourceRootRect.height);
                contentRt.anchoredPosition = Vector2.zero;
                contentRt.localScale = Vector3.one;

                var bgSprite = LoadSprite(uiFolderAssetPath, "images/bg.png");
                if (bgSprite != null)
                {
                    CreateBackground(rootRt, outputRootRect, bgSprite);
                }

                BuildChildren(root, contentRt, sourceRootRect, uiFolderAssetPath);

                var prefabPath = $"{prefabDir}/{htmlName}.prefab".Replace('\\', '/');
                PrefabUtility.SaveAsPrefabAsset(rootGo, prefabPath);
                AssetDatabase.ImportAsset(prefabPath, ImportAssetOptions.ForceSynchronousImport);
                return prefabPath;
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(rootGo);
            }
        }


        private static void BuildChildren(LayoutNode node, RectTransform parent, LayoutRect parentRectAbs, string uiFolderAssetPath)
        {
            if (node == null || node.children == null) return;
            var ordered = new List<KeyValuePair<LayoutNode, int>>();
            for (var i = 0; i < node.children.Count; i++)
            {
                var child = node.children[i];
                if (child == null) continue;
                ordered.Add(new KeyValuePair<LayoutNode, int>(child, i));
            }

            ordered.Sort((lhs, rhs) =>
            {
                var zCompare = lhs.Key.zIndex.CompareTo(rhs.Key.zIndex);
                if (zCompare != 0) return zCompare;

                var lhsDomOrder = node.children.Count - 1 - lhs.Value;
                var rhsDomOrder = node.children.Count - 1 - rhs.Value;
                return lhsDomOrder.CompareTo(rhsDomOrder);
            });

            for (var i = 0; i < ordered.Count; i++)
            {
                BuildNode(ordered[i].Key, parent, parentRectAbs, uiFolderAssetPath);
            }
        }

        private static void BuildNode(LayoutNode node, RectTransform parent, LayoutRect parentRectAbs, string uiFolderAssetPath)
        {
            var name = BuildNodeName(node);
            var go = new GameObject(name, typeof(RectTransform));
            var rt = go.GetComponent<RectTransform>();
            rt.SetParent(parent, false);
            EnsureNodeRef(go, node);

            var rect = node.rect ?? new LayoutRect();
            ConfigureRect(rt, parentRectAbs, rect, parentRectAbs);
            var visualRt = EnsureVisualRoot(rt, rect);

            var hasImageSprite = false;

            if (!string.IsNullOrEmpty(node.imagePath))
            {
                var sprite = LoadSprite(uiFolderAssetPath, node.imagePath);
                if (sprite != null)
                {
                    ApplyCaptureFrame(visualRt, rect, node.capture);
                    var img = visualRt.gameObject.AddComponent<Image>();
                    img.sprite = sprite;
                    img.raycastTarget = false;
                    img.preserveAspect = false;
                    hasImageSprite = true;
                }
            }

            if (string.Equals(node.type, "Text", StringComparison.OrdinalIgnoreCase))
            {
                var text = visualRt.gameObject.AddComponent<TextMeshProUGUI>();
                ApplyTextStyle(text, node);
            }

            if (Mathf.Abs(node.rotation) > 0.001f)
            {
                if (hasImageSprite)
                {
                    ConfigureRotationPivotFromCapture(visualRt, rect, node.capture);
                }
                else
                {
                    SetVisualPivotPreserveTopLeft(visualRt, 0.5f, 0.5f);
                }

                visualRt.localRotation = Quaternion.Euler(0f, 0f, -node.rotation);
            }

            BuildChildren(node, rt, rect, uiFolderAssetPath);
            ApplySemanticComponents(node, go);
        }

        private static void CreateBackground(RectTransform parent, LayoutRect rootRect, Sprite sprite)
        {
            var go = new GameObject("__bg", typeof(RectTransform), typeof(Image));
            var rt = go.GetComponent<RectTransform>();
            rt.SetParent(parent, false);
            
            // 鑳屾櫙鍥捐缃负 Stretch/Stretch (Anchor Min 0,0 / Max 1,1)锛孫ffset Min/Max 鍧囦负 0
            // 杩欐牱鑳屾櫙鍥炬案杩滃畬缇庨€傞厤 Canvas 澶у皬
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.pivot = new Vector2(0.5f, 0.5f);
            rt.offsetMin = Vector2.zero;
            rt.offsetMax = Vector2.zero;
            rt.localScale = Vector3.one;

            var image = go.GetComponent<Image>();
            image.sprite = sprite;
            image.raycastTarget = false;
            image.preserveAspect = false;
            go.transform.SetAsFirstSibling();
        }

        private static void ConfigureRect(RectTransform rt, LayoutRect parentRectAbs, LayoutRect nodeRectAbs, LayoutRect rootRect)
        {
            var parentRect = parentRectAbs ?? rootRect ?? new LayoutRect();
            var nodeRect = nodeRectAbs ?? new LayoutRect();

            var localX = nodeRect.x - parentRect.x;
            var localY = nodeRect.y - parentRect.y;

            rt.anchorMin = new Vector2(0f, 1f);
            rt.anchorMax = new Vector2(0f, 1f);
            rt.pivot = new Vector2(0f, 1f);
            rt.sizeDelta = new Vector2(Mathf.Max(0f, nodeRect.width), Mathf.Max(0f, nodeRect.height));
            rt.anchoredPosition = new Vector2(localX, -localY);
            rt.localScale = Vector3.one;
        }

        private static RectTransform EnsureVisualRoot(RectTransform parent, LayoutRect nodeRect)
        {
            var existing = parent.Find("__visual");
            RectTransform visualRt = null;
            if (existing != null)
            {
                visualRt = existing.GetComponent<RectTransform>();
            }

            if (visualRt == null)
            {
                var visualGo = new GameObject("__visual", typeof(RectTransform));
                visualRt = visualGo.GetComponent<RectTransform>();
                visualRt.SetParent(parent, false);
            }

            visualRt.anchorMin = new Vector2(0f, 1f);
            visualRt.anchorMax = new Vector2(0f, 1f);
            visualRt.pivot = new Vector2(0f, 1f);
            visualRt.sizeDelta = new Vector2(Mathf.Max(0f, nodeRect.width), Mathf.Max(0f, nodeRect.height));
            visualRt.anchoredPosition = Vector2.zero;
            visualRt.localScale = Vector3.one;
            visualRt.localRotation = Quaternion.identity;

            return visualRt;
        }

        private static void ApplyCaptureFrame(RectTransform visualRt, LayoutRect nodeRect, LayoutCaptureInfo capture)
        {
            if (visualRt == null)
            {
                return;
            }

            var fallbackWidth = Mathf.Max(0f, nodeRect != null ? nodeRect.width : 0f);
            var fallbackHeight = Mathf.Max(0f, nodeRect != null ? nodeRect.height : 0f);

            if (capture == null || capture.imageWidth <= 0f || capture.imageHeight <= 0f)
            {
                visualRt.sizeDelta = new Vector2(fallbackWidth, fallbackHeight);
                visualRt.anchoredPosition = Vector2.zero;
                return;
            }

            var imageWidth = Mathf.Max(0f, capture.imageWidth);
            var imageHeight = Mathf.Max(0f, capture.imageHeight);
            var offsetX = capture.contentOffsetX;
            var offsetY = capture.contentOffsetY;

            visualRt.sizeDelta = new Vector2(imageWidth, imageHeight);
            visualRt.anchoredPosition = new Vector2(-offsetX, offsetY);
        }

        private static void ConfigureRotationPivotFromCapture(RectTransform visualRt, LayoutRect nodeRect, LayoutCaptureInfo capture)
        {
            if (visualRt == null)
            {
                return;
            }

            if (capture == null || capture.imageWidth <= 0f || capture.imageHeight <= 0f ||
                capture.contentWidth <= 0f || capture.contentHeight <= 0f)
            {
                SetVisualPivotPreserveTopLeft(visualRt, 0.5f, 0.5f);
                return;
            }

            var contentCenterXFromLeft = capture.contentOffsetX + capture.contentWidth * 0.5f;
            var contentCenterYFromTop = capture.contentOffsetY + capture.contentHeight * 0.5f;

            if (capture.rotationNeutralized && nodeRect != null && nodeRect.width > 0f && nodeRect.height > 0f)
            {
                var targetCenterX = nodeRect.width * 0.5f;
                var targetCenterYFromTop = nodeRect.height * 0.5f;
                var deltaX = targetCenterX - contentCenterXFromLeft;
                var deltaYFromTop = targetCenterYFromTop - contentCenterYFromTop;
                visualRt.anchoredPosition = new Vector2(
                    visualRt.anchoredPosition.x + deltaX,
                    visualRt.anchoredPosition.y - deltaYFromTop
                );
                contentCenterXFromLeft += deltaX;
                contentCenterYFromTop += deltaYFromTop;
            }

            var pivotX = contentCenterXFromLeft / Mathf.Max(1f, capture.imageWidth);
            var pivotY = 1f - (contentCenterYFromTop / Mathf.Max(1f, capture.imageHeight));
            SetVisualPivotPreserveTopLeft(visualRt, pivotX, pivotY);
        }

        private static void SetVisualPivotPreserveTopLeft(RectTransform visualRt, float pivotX, float pivotY)
        {
            if (visualRt == null)
            {
                return;
            }

            var clampedPivotX = Mathf.Clamp01(pivotX);
            var clampedPivotY = Mathf.Clamp01(pivotY);
            var size = visualRt.sizeDelta;
            var previousPivot = visualRt.pivot;
            var topLeft = new Vector2(
                visualRt.anchoredPosition.x - previousPivot.x * size.x,
                visualRt.anchoredPosition.y + (1f - previousPivot.y) * size.y
            );

            visualRt.pivot = new Vector2(clampedPivotX, clampedPivotY);
            visualRt.anchoredPosition = new Vector2(
                topLeft.x + clampedPivotX * size.x,
                topLeft.y - (1f - clampedPivotY) * size.y
            );
        }

        private static Sprite LoadSprite(string uiFolderAssetPath, string relativeImagePath)
        {
            if (string.IsNullOrEmpty(relativeImagePath)) return null;
            var normalized = relativeImagePath.Replace('\\', '/').TrimStart('/');
            var assetPath = $"{uiFolderAssetPath}/{normalized}".Replace('\\', '/');
            return AssetDatabase.LoadAssetAtPath<Sprite>(assetPath);
        }

        private static void ApplyTextStyle(TextMeshProUGUI text, LayoutNode node)
        {
            text.text = node.text ?? string.Empty;
            text.raycastTarget = false;
            text.richText = false;
            text.enableWordWrapping = true;
            text.overflowMode = TextOverflowModes.Truncate;
            text.alignment = ToAlignment(node.style != null ? node.style.alignment : null);

            if (node.style != null)
            {
                text.fontSize = ParseCssPx(node.style.fontSize, 16f);
                text.color = ParseCssColor(node.style.color, Color.black);
                text.fontStyle = ToFontStyle(node.style);
                var lineHeight = ParseCssPx(node.style.lineHeight, text.fontSize * 1.2f);
                var extra = lineHeight - text.fontSize;
                text.lineSpacing = extra;
            }
        }

        private static void ApplySemanticComponents(LayoutNode node, GameObject go)
        {
            if (node == null || go == null) return;

            var tag = (node.htmlTag ?? string.Empty).Trim().ToLowerInvariant();
            var role = (string.IsNullOrEmpty(node.role) ? GetAttr(node, "role") : node.role).Trim().ToLowerInvariant();
            var inputType = ResolveInputType(node);

            if (IsButtonLike(tag, role))
            {
                EnsureButton(go, node);
                return;
            }

            if (string.Equals(tag, "textarea", StringComparison.OrdinalIgnoreCase) || IsTextInput(tag, inputType))
            {
                EnsureTmpInputField(go, node, string.Equals(tag, "textarea", StringComparison.OrdinalIgnoreCase));
                return;
            }

            if (string.Equals(tag, "input", StringComparison.OrdinalIgnoreCase) &&
                (string.Equals(inputType, "checkbox", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(inputType, "radio", StringComparison.OrdinalIgnoreCase)))
            {
                EnsureToggle(go, node);
            }
        }

        private static bool IsButtonLike(string tag, string role)
        {
            if (string.Equals(tag, "button", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(role, "button", StringComparison.OrdinalIgnoreCase)) return true;
            return string.Equals(tag, "a", StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(role, "button", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsTextInput(string tag, string inputType)
        {
            if (!string.Equals(tag, "input", StringComparison.OrdinalIgnoreCase)) return false;
            if (string.IsNullOrEmpty(inputType)) return true;

            var nonTextTypes = new[]
            {
                "button", "submit", "reset", "checkbox", "radio", "file",
                "range", "color", "image", "hidden"
            };
            for (var i = 0; i < nonTextTypes.Length; i++)
            {
                if (string.Equals(inputType, nonTextTypes[i], StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }

            return true;
        }

        private static string ResolveInputType(LayoutNode node)
        {
            var inputType = (node != null ? node.inputType : string.Empty) ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(inputType)) return inputType.Trim().ToLowerInvariant();

            var raw = GetAttr(node, "type");
            return string.IsNullOrWhiteSpace(raw) ? "text" : raw.Trim().ToLowerInvariant();
        }

        private static Image EnsureRaycastImage(GameObject go)
        {
            var image = go.GetComponent<Image>();
            if (image == null)
            {
                image = go.AddComponent<Image>();
                image.color = new Color(1f, 1f, 1f, 0f);
            }

            image.raycastTarget = true;
            return image;
        }

        private static void EnsureButton(GameObject go, LayoutNode node)
        {
            var button = go.GetComponent<Button>();
            if (button == null) button = go.AddComponent<Button>();
            button.targetGraphic = EnsureRaycastImage(go);
            button.interactable = !HasBooleanAttr(node, "disabled");

            var stateDriver = go.GetComponent<UiStateDriver>();
            if (stateDriver == null) stateDriver = go.AddComponent<UiStateDriver>();
            ConfigureButtonStateDriver(stateDriver, node);
            stateDriver.TryAutoBindTargets(true);
        }

        private static void EnsureTmpInputField(GameObject go, LayoutNode node, bool multiline)
        {
            var inputField = go.GetComponent<TMP_InputField>();
            if (inputField == null) inputField = go.AddComponent<TMP_InputField>();

            inputField.targetGraphic = EnsureRaycastImage(go);

            var textArea = EnsureChildRect(go.transform, "__input_text_area");
            SetStretch(textArea, 8f, 6f, 8f, 6f);

            var text = EnsureChildText(textArea, "__input_text");
            text.raycastTarget = false;
            text.enableWordWrapping = multiline;
            text.alignment = TextAlignmentOptions.Left;
            text.overflowMode = multiline ? TextOverflowModes.Overflow : TextOverflowModes.Truncate;
            text.text = string.Empty;

            var placeholder = EnsureChildText(textArea, "__input_placeholder");
            placeholder.raycastTarget = false;
            placeholder.enableWordWrapping = multiline;
            placeholder.alignment = text.alignment;
            placeholder.overflowMode = text.overflowMode;
            placeholder.text = GetAttr(node, "placeholder");
            placeholder.color = new Color(1f, 1f, 1f, 0.45f);

            inputField.textViewport = textArea;
            inputField.textComponent = text;
            inputField.placeholder = placeholder;
            inputField.lineType = multiline
                ? TMP_InputField.LineType.MultiLineNewline
                : TMP_InputField.LineType.SingleLine;
            inputField.contentType = ToInputContentType(ResolveInputType(node));
            inputField.readOnly = HasBooleanAttr(node, "readonly");
            inputField.interactable = !HasBooleanAttr(node, "disabled");

            var initialValue = GetAttr(node, "value");
            if (!string.IsNullOrEmpty(initialValue))
            {
                inputField.SetTextWithoutNotify(initialValue);
            }
        }

        private static TMP_InputField.ContentType ToInputContentType(string inputType)
        {
            if (string.IsNullOrEmpty(inputType)) return TMP_InputField.ContentType.Standard;
            if (string.Equals(inputType, "password", StringComparison.OrdinalIgnoreCase))
            {
                return TMP_InputField.ContentType.Password;
            }

            if (string.Equals(inputType, "email", StringComparison.OrdinalIgnoreCase))
            {
                return TMP_InputField.ContentType.EmailAddress;
            }

            if (string.Equals(inputType, "number", StringComparison.OrdinalIgnoreCase))
            {
                return TMP_InputField.ContentType.DecimalNumber;
            }

            return TMP_InputField.ContentType.Standard;
        }

        private static void EnsureToggle(GameObject go, LayoutNode node)
        {
            var toggle = go.GetComponent<Toggle>();
            if (toggle == null) toggle = go.AddComponent<Toggle>();

            toggle.targetGraphic = EnsureRaycastImage(go);

            var checkRect = EnsureChildRect(go.transform, "__toggle_check");
            SetStretch(checkRect, 4f, 4f, 4f, 4f);
            var checkImage = checkRect.GetComponent<Image>();
            if (checkImage == null) checkImage = checkRect.gameObject.AddComponent<Image>();
            if (checkImage.color.a <= 0.001f)
            {
                checkImage.color = new Color(0.2f, 0.75f, 0.2f, 0.9f);
            }
            checkImage.raycastTarget = false;

            toggle.graphic = checkImage;
            toggle.isOn = HasBooleanAttr(node, "checked");
            toggle.interactable = !HasBooleanAttr(node, "disabled");
        }

        private static RectTransform EnsureChildRect(Transform parent, string name)
        {
            var existing = parent.Find(name);
            if (existing != null)
            {
                var existingRt = existing.GetComponent<RectTransform>();
                if (existingRt != null) return existingRt;
            }

            var child = new GameObject(name, typeof(RectTransform));
            var rt = child.GetComponent<RectTransform>();
            rt.SetParent(parent, false);
            return rt;
        }

        private static TextMeshProUGUI EnsureChildText(RectTransform parent, string name)
        {
            var existing = parent.Find(name);
            TextMeshProUGUI text = null;
            RectTransform rt = null;
            if (existing != null)
            {
                rt = existing.GetComponent<RectTransform>();
                text = existing.GetComponent<TextMeshProUGUI>();
            }

            if (rt == null)
            {
                var go = new GameObject(name, typeof(RectTransform));
                rt = go.GetComponent<RectTransform>();
                rt.SetParent(parent, false);
            }

            if (text == null)
            {
                text = rt.gameObject.AddComponent<TextMeshProUGUI>();
            }

            SetStretch(rt, 0f, 0f, 0f, 0f);
            return text;
        }

        private static void SetStretch(RectTransform rt, float left, float top, float right, float bottom)
        {
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.pivot = new Vector2(0.5f, 0.5f);
            rt.offsetMin = new Vector2(left, bottom);
            rt.offsetMax = new Vector2(-right, -top);
            rt.localScale = Vector3.one;
            rt.localRotation = Quaternion.identity;
        }

        private static string GetAttr(LayoutNode node, string key)
        {
            if (node == null || string.IsNullOrWhiteSpace(key)) return string.Empty;
            if (node.attrs == null) return string.Empty;
            for (var i = 0; i < node.attrs.Count; i++)
            {
                var attr = node.attrs[i];
                if (attr == null) continue;
                if (!string.Equals(attr.key, key, StringComparison.OrdinalIgnoreCase)) continue;
                return attr.value ?? string.Empty;
            }

            return string.Empty;
        }

        private static bool HasBooleanAttr(LayoutNode node, string key)
        {
            var raw = GetAttr(node, key);
            if (string.IsNullOrWhiteSpace(raw)) return false;
            if (string.Equals(raw, "false", StringComparison.OrdinalIgnoreCase)) return false;
            if (string.Equals(raw, "0", StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }

        private static FontStyles ToFontStyle(LayoutTextStyle style)
        {
            var result = FontStyles.Normal;
            if (style == null) return result;

            if (IsBold(style.fontWeight))
            {
                result |= FontStyles.Bold;
            }

            if (!string.IsNullOrEmpty(style.fontStyle) &&
                style.fontStyle.IndexOf("italic", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                result |= FontStyles.Italic;
            }

            if (!string.IsNullOrEmpty(style.textDecoration) &&
                style.textDecoration.IndexOf("underline", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                result |= FontStyles.Underline;
            }

            return result;
        }

        private static bool IsBold(string fontWeight)
        {
            if (string.IsNullOrEmpty(fontWeight)) return false;
            if (int.TryParse(fontWeight, NumberStyles.Integer, CultureInfo.InvariantCulture, out var weight))
            {
                return weight >= 600;
            }

            return fontWeight.IndexOf("bold", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static TextAlignmentOptions ToAlignment(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return TextAlignmentOptions.TopLeft;
            if (raw.IndexOf("center", StringComparison.OrdinalIgnoreCase) >= 0) return TextAlignmentOptions.Top;
            if (raw.IndexOf("right", StringComparison.OrdinalIgnoreCase) >= 0) return TextAlignmentOptions.TopRight;
            return TextAlignmentOptions.TopLeft;
        }

        private static float ParseCssPx(string raw, float fallback)
        {
            if (string.IsNullOrWhiteSpace(raw)) return fallback;
            var normalized = raw.Trim().Replace("px", string.Empty).Trim();
            if (float.TryParse(normalized, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
            {
                return value;
            }

            return fallback;
        }

        private static Color ParseCssColor(string raw, Color fallback)
        {
            if (string.IsNullOrWhiteSpace(raw)) return fallback;
            var trimmed = raw.Trim();

            if (trimmed.StartsWith("#", StringComparison.Ordinal))
            {
                if (ColorUtility.TryParseHtmlString(trimmed, out var hexColor))
                {
                    return hexColor;
                }
            }

            if (trimmed.StartsWith("rgb", StringComparison.OrdinalIgnoreCase))
            {
                var start = trimmed.IndexOf('(');
                var end = trimmed.IndexOf(')');
                if (start >= 0 && end > start)
                {
                    var parts = trimmed.Substring(start + 1, end - start - 1).Split(',');
                    if (parts.Length >= 3)
                    {
                        var r = ParseCssByte(parts[0]);
                        var g = ParseCssByte(parts[1]);
                        var b = ParseCssByte(parts[2]);
                        var a = 1f;
                        if (parts.Length >= 4 &&
                            float.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var parsedA))
                        {
                            a = Mathf.Clamp01(parsedA);
                        }

                        return new Color32(r, g, b, (byte)Mathf.RoundToInt(a * 255f));
                    }
                }
            }

            if (string.Equals(trimmed, "transparent", StringComparison.OrdinalIgnoreCase))
            {
                return new Color(0f, 0f, 0f, 0f);
            }

            return fallback;
        }

        private static byte ParseCssByte(string raw)
        {
            if (float.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
            {
                return (byte)Mathf.Clamp(Mathf.RoundToInt(value), 0, 255);
            }

            return 0;
        }

        private static string BuildNodeName(LayoutNode node)
        {
            var id = string.IsNullOrEmpty(node.id) ? "node" : node.id;
            var shortId = id.Length > 8 ? id.Substring(0, 8) : id;
            var type = string.IsNullOrEmpty(node.type) ? "Node" : node.type;
            return $"{type}_{shortId}";
        }

        private static void EnsureNodeRef(GameObject go, LayoutNode node)
        {
            if (go == null || node == null) return;
            var nodeRef = go.GetComponent<UiNodeRef>();
            if (nodeRef == null) nodeRef = go.AddComponent<UiNodeRef>();
            nodeRef.Initialize(
                node.id,
                node.type,
                node.htmlTag,
                node.role,
                node.inputType,
                node.domPath
            );
        }

        private static void ConfigureButtonStateDriver(UiStateDriver driver, LayoutNode node)
        {
            if (driver == null) return;

            var normalState = UiVisualState.Default();

            var hoverState = UiVisualState.Default();
            hoverState.graphicMultiplier = new Color(1.06f, 1.06f, 1.06f, 1f);
            hoverState.textMultiplier = new Color(1.06f, 1.06f, 1.06f, 1f);
            hoverState.scaleMultiplier = HasClass(node, "hover:scale-105") ? 1.05f : 1.01f;

            var pressedState = UiVisualState.Default();
            pressedState.graphicMultiplier = new Color(0.93f, 0.93f, 0.93f, 1f);
            pressedState.textMultiplier = new Color(0.93f, 0.93f, 0.93f, 1f);
            pressedState.scaleMultiplier = 0.995f;
            pressedState.positionOffset = ResolvePressedOffset(node);
            pressedState.shadowAlphaMultiplier = 0.85f;

            var disabledState = UiVisualState.Default();
            disabledState.graphicMultiplier = new Color(1f, 1f, 1f, 0.55f);
            disabledState.textMultiplier = new Color(1f, 1f, 1f, 0.55f);
            disabledState.scaleMultiplier = 1f;
            disabledState.shadowAlphaMultiplier = 0.3f;

            driver.Configure(normalState, hoverState, pressedState, disabledState);
        }

        private static Vector2 ResolvePressedOffset(LayoutNode node)
        {
            var x = 1f;
            var y = -1f;

            if (TryGetActiveTranslatePixels(node, "x", out var cssX))
            {
                x = cssX;
            }

            if (TryGetActiveTranslatePixels(node, "y", out var cssY))
            {
                y = -cssY;
            }

            return new Vector2(x, y);
        }

        private static bool TryGetActiveTranslatePixels(LayoutNode node, string axis, out float value)
        {
            value = 0f;
            if (node == null || node.classes == null || string.IsNullOrWhiteSpace(axis))
            {
                return false;
            }

            var normalizedAxis = axis.Trim().ToLowerInvariant();
            var positivePrefix = $"active:translate-{normalizedAxis}-[";
            var negativePrefix = $"active:-translate-{normalizedAxis}-[";

            for (var i = 0; i < node.classes.Count; i++)
            {
                var rawClass = node.classes[i];
                if (string.IsNullOrWhiteSpace(rawClass)) continue;
                var cls = rawClass.Trim();

                var sign = 1f;
                var prefix = string.Empty;
                if (cls.StartsWith(positivePrefix, StringComparison.OrdinalIgnoreCase))
                {
                    prefix = positivePrefix;
                    sign = 1f;
                }
                else if (cls.StartsWith(negativePrefix, StringComparison.OrdinalIgnoreCase))
                {
                    prefix = negativePrefix;
                    sign = -1f;
                }
                else
                {
                    continue;
                }

                if (!cls.EndsWith("px]", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var numericLength = cls.Length - prefix.Length - 3;
                if (numericLength <= 0) continue;

                var numericText = cls.Substring(prefix.Length, numericLength);
                if (!float.TryParse(numericText, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
                {
                    continue;
                }

                value = parsed * sign;
                return true;
            }

            return false;
        }

        private static bool HasClass(LayoutNode node, string className)
        {
            if (node == null || node.classes == null || string.IsNullOrWhiteSpace(className))
            {
                return false;
            }

            for (var i = 0; i < node.classes.Count; i++)
            {
                if (string.Equals(node.classes[i], className, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private static void EnsureFolder(string parent, string child)
        {
            if (AssetDatabase.IsValidFolder($"{parent}/{child}".Replace('\\', '/'))) return;
            AssetDatabase.CreateFolder(parent, child);
        }
    }
}

