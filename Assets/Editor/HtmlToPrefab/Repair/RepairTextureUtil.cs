using System;
using System.IO;
using HtmlToPrefab.Runtime;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace HtmlToPrefab.Editor.Repair
{
    internal static class RepairTextureUtil
    {
        public static bool TryLoadPreviewTexture(
            string variantImagePath,
            out Texture2D texture,
            out string absolutePath,
            out string error
        )
        {
            texture = null;
            absolutePath = string.Empty;
            error = string.Empty;

            if (string.IsNullOrWhiteSpace(variantImagePath))
            {
                error = "Variant imagePath is empty.";
                return false;
            }

            absolutePath = ResolveAbsolutePath(variantImagePath);
            if (!File.Exists(absolutePath))
            {
                error = $"Preview image not found: {absolutePath}";
                return false;
            }

            return TryLoadTextureFromAbsolutePath(absolutePath, out texture, out error);
        }

        public static bool TryLoadTextureFromAbsolutePath(string absolutePath, out Texture2D texture, out string error)
        {
            texture = null;
            error = string.Empty;
            if (string.IsNullOrWhiteSpace(absolutePath) || !File.Exists(absolutePath))
            {
                error = $"Image not found: {absolutePath}";
                return false;
            }

            try
            {
                var bytes = File.ReadAllBytes(absolutePath);
                var loaded = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                loaded.hideFlags = HideFlags.HideAndDontSave;
                if (!loaded.LoadImage(bytes, false))
                {
                    UnityEngine.Object.DestroyImmediate(loaded);
                    error = "Texture2D.LoadImage failed.";
                    return false;
                }

                loaded.wrapMode = TextureWrapMode.Clamp;
                loaded.filterMode = FilterMode.Bilinear;
                texture = loaded;
                return true;
            }
            catch (Exception ex)
            {
                error = $"Load image failed: {ex.Message}";
                return false;
            }
        }

        public static bool TryCreatePreviewSprite(
            string absoluteImagePath,
            out Texture2D texture,
            out Sprite sprite,
            out string error,
            float pixelsPerUnit = 100f
        )
        {
            texture = null;
            sprite = null;
            error = string.Empty;

            if (!TryLoadTextureFromAbsolutePath(absoluteImagePath, out texture, out error))
            {
                return false;
            }

            try
            {
                var rect = new Rect(0f, 0f, texture.width, texture.height);
                sprite = Sprite.Create(texture, rect, new Vector2(0.5f, 0.5f), Mathf.Max(1f, pixelsPerUnit));
                sprite.hideFlags = HideFlags.HideAndDontSave;
                return true;
            }
            catch (Exception ex)
            {
                if (texture != null)
                {
                    UnityEngine.Object.DestroyImmediate(texture);
                }
                error = $"Create sprite failed: {ex.Message}";
                return false;
            }
        }

        public static void ReleaseTexture(Texture2D texture)
        {
            if (texture == null) return;
            UnityEngine.Object.DestroyImmediate(texture);
        }

        public static void ReleaseSprite(Sprite sprite)
        {
            if (sprite == null) return;
            UnityEngine.Object.DestroyImmediate(sprite);
        }

        public static bool TryGetTargetImage(int nodeInstanceId, out Image image, out string error)
        {
            image = null;
            error = string.Empty;

            var obj = EditorUtility.InstanceIDToObject(nodeInstanceId) as UiNodeRef;
            if (obj == null)
            {
                error = "UiNodeRef instance not found.";
                return false;
            }

            var visual = obj.transform.Find("__visual");
            if (visual != null)
            {
                image = visual.GetComponent<Image>();
            }

            if (image == null)
            {
                image = obj.GetComponent<Image>();
            }

            if (image == null)
            {
                var images = obj.GetComponentsInChildren<Image>(true);
                for (var i = 0; i < images.Length; i++)
                {
                    if (images[i] == null) continue;
                    if (images[i].sprite != null)
                    {
                        image = images[i];
                        break;
                    }
                    if (image == null)
                    {
                        image = images[i];
                    }
                }
            }

            if (image == null)
            {
                error = $"Target Image component not found for node [{obj.NodeId}].";
                return false;
            }

            return true;
        }

        public static bool TryAssignPreviewSprite(
            int nodeInstanceId,
            Sprite previewSprite,
            out string error
        )
        {
            error = string.Empty;
            if (previewSprite == null)
            {
                error = "Preview sprite is null.";
                return false;
            }

            if (!TryGetTargetImage(nodeInstanceId, out var image, out error))
            {
                return false;
            }

            Undo.RecordObject(image, "Preview Repair Variant");
            image.sprite = previewSprite;
            image.SetNativeSize();
            EditorUtility.SetDirty(image);
            return true;
        }

        public static bool TryRestoreOriginalSprite(
            int nodeInstanceId,
            Sprite originalSprite,
            out string error
        )
        {
            error = string.Empty;
            if (!TryGetTargetImage(nodeInstanceId, out var image, out error))
            {
                return false;
            }

            Undo.RecordObject(image, "Restore Original Sprite");
            image.sprite = originalSprite;
            if (image.sprite != null)
            {
                image.SetNativeSize();
            }
            EditorUtility.SetDirty(image);
            return true;
        }

        public static bool TryBindImportedSprite(
            int nodeInstanceId,
            string targetAssetPath,
            out string error
        )
        {
            error = string.Empty;
            if (string.IsNullOrWhiteSpace(targetAssetPath))
            {
                error = "Target asset path is empty.";
                return false;
            }

            var normalized = targetAssetPath.Replace('\\', '/');
            var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(normalized);
            if (sprite == null)
            {
                error = $"Imported sprite load failed: {normalized}";
                return false;
            }

            if (!TryGetTargetImage(nodeInstanceId, out var image, out error))
            {
                return false;
            }

            Undo.RecordObject(image, "Bind Imported Repair Sprite");
            image.sprite = sprite;
            image.SetNativeSize();
            EditorUtility.SetDirty(image);
            return true;
        }

        public static bool ApplyVariantImage(string variantAbsolutePath, string targetAssetPath, out string error)
        {
            error = string.Empty;
            try
            {
                if (string.IsNullOrWhiteSpace(variantAbsolutePath) || !File.Exists(variantAbsolutePath))
                {
                    error = $"Variant image missing: {variantAbsolutePath}";
                    return false;
                }

                if (string.IsNullOrWhiteSpace(targetAssetPath))
                {
                    error = "Target asset path is empty.";
                    return false;
                }

                var normalizedAssetPath = targetAssetPath.Replace('\\', '/');
                var targetAbsolutePath = HtmlToPrefab.Editor.AssetPathUtil.ToAbsolutePath(normalizedAssetPath);
                var parent = Path.GetDirectoryName(targetAbsolutePath);
                if (!string.IsNullOrEmpty(parent))
                {
                    Directory.CreateDirectory(parent);
                }

                File.Copy(variantAbsolutePath, targetAbsolutePath, true);
                AssetDatabase.ImportAsset(
                    normalizedAssetPath,
                    ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate
                );
                return true;
            }
            catch (Exception ex)
            {
                error = $"Apply variant failed: {ex.Message}";
                return false;
            }
        }

        public static bool TryApplyMetadataOffset(
            int nodeInstanceId,
            RepairVariantMetadata metadata,
            string targetAssetPath,
            out string message
        )
        {
            message = string.Empty;
            if (metadata == null) return false;

            var offsetX = metadata.contentOffsetX;
            var offsetY = metadata.contentOffsetY;
            var hasOffset = Mathf.Abs(offsetX) > 0.001f || Mathf.Abs(offsetY) > 0.001f;
            if (!hasOffset)
            {
                return false;
            }

            var obj = EditorUtility.InstanceIDToObject(nodeInstanceId) as UiNodeRef;
            if (obj == null)
            {
                message = $"Repair metadata detected offset ({offsetX}, {offsetY}), but node instance is unavailable. Please verify pivot/position manually.";
                return false;
            }

            var visual = obj.transform.Find("__visual");
            var image = visual != null ? visual.GetComponent<Image>() : obj.GetComponent<Image>();
            var rect = image != null
                ? image.rectTransform
                : (visual != null ? visual as RectTransform : obj.GetComponent<RectTransform>());

            if (rect == null)
            {
                message = $"Repair metadata detected offset ({offsetX}, {offsetY}), but target RectTransform not found. Please verify manually.";
                return false;
            }

            Undo.RecordObject(rect, "Apply Repair Metadata Offset");
            rect.anchoredPosition += new Vector2(-offsetX, offsetY);

            if (!string.IsNullOrWhiteSpace(targetAssetPath))
            {
                var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(targetAssetPath);
                if (sprite != null)
                {
                    rect.sizeDelta = sprite.rect.size;
                }
            }

            EditorUtility.SetDirty(rect);
            if (obj.gameObject != null)
            {
                EditorUtility.SetDirty(obj.gameObject);
            }

            message = $"Applied metadata offset for node [{obj.NodeId}] => contentOffset ({offsetX}, {offsetY}).";
            return true;
        }

        public static bool DeleteFileQuietly(string absolutePath)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(absolutePath)) return false;
                if (!File.Exists(absolutePath)) return false;
                File.Delete(absolutePath);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string ResolveAbsolutePath(string imagePath)
        {
            if (Path.IsPathRooted(imagePath))
            {
                return imagePath;
            }

            var projectRoot = Directory.GetParent(Application.dataPath)?.FullName ?? string.Empty;
            return Path.GetFullPath(Path.Combine(projectRoot, imagePath));
        }
    }
}
