using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace HtmlToPrefab.Editor
{
    [Serializable]
    internal sealed class UiIndexAttribute
    {
        public string key;
        public string value;
    }

    [Serializable]
    internal sealed class UiIndexItem
    {
        public string id;
        public string parentId;
        public string type;
        public string htmlTag;
        public string role;
        public string inputType;
        public string domPath;
        public List<string> classes = new List<string>();
        public List<UiIndexAttribute> attrs = new List<UiIndexAttribute>();
        public int depth;
        public int siblingIndex;

        public float x;
        public float y;
        public float width;
        public float height;
        public float rotation;

        public string imagePath;
        public string imageResourcePath;

        public string text;
        public string textColor;
        public string fontSize;
        public string alignment;
    }

    [Serializable]
    internal sealed class UiIndexFile
    {
        public string htmlName;
        public float width;
        public float height;
        public List<UiIndexItem> items = new List<UiIndexItem>();
    }

    internal static class LayoutIndexBuilder
    {
        public static string WriteIndex(LayoutNode root, string htmlName, string uiFolderAssetPath)
        {
            if (root == null) throw new ArgumentNullException(nameof(root));

            var index = new UiIndexFile
            {
                htmlName = htmlName ?? string.Empty,
                width = root.rect != null ? root.rect.width : 0f,
                height = root.rect != null ? root.rect.height : 0f
            };

            Traverse(root, null, 0, 0, htmlName, index.items);

            var json = JsonUtility.ToJson(index, true);
            var indexAssetPath = $"{uiFolderAssetPath}/ui_index.json".Replace('\\', '/');
            File.WriteAllText(AssetPathUtil.ToAbsolutePath(indexAssetPath), json);
            return indexAssetPath;
        }

        private static void Traverse(
            LayoutNode node,
            string parentId,
            int depth,
            int siblingIndex,
            string htmlName,
            List<UiIndexItem> items
        )
        {
            if (node == null) return;
            var rect = node.rect ?? new LayoutRect();
            var item = new UiIndexItem
            {
                id = node.id ?? string.Empty,
                parentId = parentId ?? string.Empty,
                type = node.type ?? string.Empty,
                htmlTag = node.htmlTag ?? string.Empty,
                role = node.role ?? string.Empty,
                inputType = node.inputType ?? string.Empty,
                domPath = node.domPath ?? string.Empty,
                classes = node.classes != null ? new List<string>(node.classes) : new List<string>(),
                attrs = ToIndexAttrs(node.attrs),
                depth = depth,
                siblingIndex = siblingIndex,
                x = rect.x,
                y = rect.y,
                width = rect.width,
                height = rect.height,
                rotation = node.rotation,
                imagePath = node.imagePath ?? string.Empty,
                imageResourcePath = ResolveImageResourcePath(node.imagePath, htmlName),
                text = node.text ?? string.Empty,
                textColor = node.style != null ? node.style.color ?? string.Empty : string.Empty,
                fontSize = node.style != null ? node.style.fontSize ?? string.Empty : string.Empty,
                alignment = node.style != null ? node.style.alignment ?? string.Empty : string.Empty
            };
            items.Add(item);

            if (node.children == null) return;
            for (var i = 0; i < node.children.Count; i++)
            {
                Traverse(node.children[i], node.id, depth + 1, i, htmlName, items);
            }
        }

        private static string ResolveImageResourcePath(string imagePath, string htmlName)
        {
            if (string.IsNullOrEmpty(imagePath)) return string.Empty;
            var normalized = imagePath.Replace('\\', '/').TrimStart('/');
            if (normalized.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
            {
                normalized = normalized.Substring(0, normalized.Length - 4);
            }

            var safeName = string.IsNullOrEmpty(htmlName) ? "HtmlBaked" : htmlName;
            return $"UI/{safeName}/{normalized}";
        }

        private static List<UiIndexAttribute> ToIndexAttrs(List<LayoutAttribute> attrs)
        {
            var result = new List<UiIndexAttribute>();
            if (attrs == null) return result;
            for (var i = 0; i < attrs.Count; i++)
            {
                var attr = attrs[i];
                if (attr == null) continue;
                result.Add(new UiIndexAttribute
                {
                    key = attr.key ?? string.Empty,
                    value = attr.value ?? string.Empty
                });
            }

            return result;
        }
    }
}
