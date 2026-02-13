using System;
using UnityEngine;

namespace HtmlToPrefab.Runtime
{
    [Serializable]
    public struct UiVisualState
    {
        public Color graphicMultiplier;
        public Color textMultiplier;
        public float scaleMultiplier;
        public Vector2 positionOffset;
        public Vector2 shadowOffset;
        public float shadowAlphaMultiplier;

        public static UiVisualState Default()
        {
            return new UiVisualState
            {
                graphicMultiplier = Color.white,
                textMultiplier = Color.white,
                scaleMultiplier = 1f,
                positionOffset = Vector2.zero,
                shadowOffset = Vector2.zero,
                shadowAlphaMultiplier = 1f,
            };
        }
    }
}
