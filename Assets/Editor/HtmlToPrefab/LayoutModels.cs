using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace HtmlToPrefab.Editor
{
    [Serializable]
    internal sealed class LayoutRect
    {
        public float x;
        public float y;
        public float width;
        public float height;
    }

    [Serializable]
    internal sealed class LayoutTextStyle
    {
        public string color;
        public string fontSize;
        public string fontFamily;
        public string alignment;
        public string fontWeight;
        public string fontStyle;
        public string lineHeight;
        public string letterSpacing;
        public string textTransform;
        public string textDecoration;
        public string textShadow;
        public string whiteSpace;
        public string wordBreak;
        public string wordSpacing;
        public string textIndent;
        public string textOverflow;
        public string direction;
    }

    [Serializable]
    internal sealed class LayoutAttribute
    {
        public string key;
        public string value;
    }

    [Serializable]
    internal sealed class LayoutCaptureInfo
    {
        public string mode;
        public float imageWidth;
        public float imageHeight;
        public float contentOffsetX;
        public float contentOffsetY;
        public float contentWidth;
        public float contentHeight;
        public float visibilityRatio;
        public bool rotationNeutralized;
    }

    [Serializable]
    internal sealed class LayoutNode
    {
        public string id;
        public string type;
        public string htmlTag;
        public int zIndex;
        public string role;
        public string inputType;
        public List<string> classes;
        public List<LayoutAttribute> attrs;
        public string domPath;
        public LayoutRect rect;
        public LayoutRect contentBounds;
        public float rotation;
        public bool transformNeutralized;
        public int neutralizedAncestorCount;
        public List<LayoutNode> children;

        public string imagePath;
        public LayoutCaptureInfo capture;
        public bool rotationBaked;
        public float rotationOriginal;

        public string text;
        public LayoutTextStyle style;
    }

    internal static class LayoutJsonLoader
    {
        public static LayoutNode LoadFromAssetPath(string layoutAssetPath)
        {
            var absolutePath = AssetPathUtil.ToAbsolutePath(layoutAssetPath);
            if (!File.Exists(absolutePath))
            {
                throw new FileNotFoundException($"layout.json not found: {absolutePath}");
            }

            var json = File.ReadAllText(absolutePath);
            var root = JsonUtility.FromJson<LayoutNode>(json);
            if (root == null)
            {
                throw new InvalidDataException($"Failed to parse layout json: {layoutAssetPath}");
            }

            Normalize(root);
            return root;
        }

        private static void Normalize(LayoutNode node)
        {
            if (node == null) return;
            if (node.rect == null) node.rect = new LayoutRect();
            if (node.children == null) node.children = new List<LayoutNode>();
            if (node.classes == null) node.classes = new List<string>();
            if (node.attrs == null) node.attrs = new List<LayoutAttribute>();
            if (node.capture == null) node.capture = new LayoutCaptureInfo();
            for (var i = 0; i < node.children.Count; i++)
            {
                Normalize(node.children[i]);
            }
        }
    }

    internal static class AssetPathUtil
    {
        public static string ToAbsolutePath(string assetPath)
        {
            var projectRoot = Directory.GetParent(Application.dataPath)?.FullName;
            if (string.IsNullOrEmpty(projectRoot))
            {
                throw new InvalidOperationException("Cannot resolve Unity project root.");
            }

            var relative = assetPath.Replace('/', Path.DirectorySeparatorChar);
            return Path.Combine(projectRoot, relative);
        }

        public static string ToResourcesPath(string assetPath)
        {
            var normalized = assetPath.Replace('\\', '/');
            const string prefix = "Assets/Resources/";
            if (!normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return string.Empty;
            }

            var withoutPrefix = normalized.Substring(prefix.Length);
            var withoutExt = Path.ChangeExtension(withoutPrefix, null);
            return withoutExt?.Replace('\\', '/') ?? string.Empty;
        }
    }
}
