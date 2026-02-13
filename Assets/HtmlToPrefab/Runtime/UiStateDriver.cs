using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace HtmlToPrefab.Runtime
{
    [DisallowMultipleComponent]
    public sealed class UiStateDriver : MonoBehaviour,
        IPointerEnterHandler,
        IPointerExitHandler,
        IPointerDownHandler,
        IPointerUpHandler,
        ISelectHandler,
        IDeselectHandler
    {
        [SerializeField] private bool _autoBindTargets = true;
        [SerializeField] private Selectable _selectable;
        [SerializeField] private Graphic _targetGraphic;
        [SerializeField] private TMP_Text _targetText;
        [SerializeField] private RectTransform _targetRect;
        [SerializeField] private Shadow _targetShadow;

        [SerializeField] private UiVisualState _normalState = default;
        [SerializeField] private UiVisualState _hoverState = default;
        [SerializeField] private UiVisualState _pressedState = default;
        [SerializeField] private UiVisualState _disabledState = default;

        private bool _hovered;
        private bool _pressed;
        private bool _selected;
        private bool _initialized;
        private bool _lastInteractable = true;

        private Color _baseGraphicColor = Color.white;
        private Color _baseTextColor = Color.white;
        private Vector3 _baseScale = Vector3.one;
        private Vector2 _baseAnchoredPosition = Vector2.zero;
        private Vector2 _baseShadowDistance = Vector2.zero;
        private Color _baseShadowColor = Color.black;

        private void Reset()
        {
            _normalState = UiVisualState.Default();
            _hoverState = UiVisualState.Default();
            _pressedState = UiVisualState.Default();
            _disabledState = UiVisualState.Default();
        }

        private void Awake()
        {
            EnsureDefaultStates();
            if (_autoBindTargets)
            {
                TryAutoBindTargets(true);
            }
            else
            {
                CaptureBaseState();
            }
        }

        private void OnEnable()
        {
            EnsureDefaultStates();
            if (!_initialized)
            {
                if (_autoBindTargets) TryAutoBindTargets(true);
                else CaptureBaseState();
            }

            _lastInteractable = IsInteractable();
            ApplyCurrentState();
        }

        private void LateUpdate()
        {
            var interactable = IsInteractable();
            if (interactable == _lastInteractable) return;
            _lastInteractable = interactable;
            ApplyCurrentState();
        }

        private void OnDisable()
        {
            RestoreBaseState();
        }

        public void Configure(
            UiVisualState normalState,
            UiVisualState hoverState,
            UiVisualState pressedState,
            UiVisualState disabledState
        )
        {
            _normalState = normalState;
            _hoverState = hoverState;
            _pressedState = pressedState;
            _disabledState = disabledState;
            ApplyCurrentState();
        }

        public void TryAutoBindTargets(bool recaptureBaseState = true)
        {
            if (_selectable == null) _selectable = GetComponent<Selectable>();
            if (_targetGraphic == null) _targetGraphic = GetComponent<Graphic>();
            if (_targetText == null) _targetText = GetComponent<TMP_Text>();
            if (_targetRect == null) _targetRect = GetComponent<RectTransform>();
            if (_targetShadow == null) _targetShadow = GetComponent<Shadow>();
            if (recaptureBaseState) CaptureBaseState();
        }

        public void OnPointerEnter(PointerEventData eventData)
        {
            _hovered = true;
            ApplyCurrentState();
        }

        public void OnPointerExit(PointerEventData eventData)
        {
            _hovered = false;
            _pressed = false;
            ApplyCurrentState();
        }

        public void OnPointerDown(PointerEventData eventData)
        {
            if (eventData != null && eventData.button != PointerEventData.InputButton.Left) return;
            _pressed = true;
            ApplyCurrentState();
        }

        public void OnPointerUp(PointerEventData eventData)
        {
            _pressed = false;
            ApplyCurrentState();
        }

        public void OnSelect(BaseEventData eventData)
        {
            _selected = true;
            ApplyCurrentState();
        }

        public void OnDeselect(BaseEventData eventData)
        {
            _selected = false;
            _pressed = false;
            ApplyCurrentState();
        }

        private void CaptureBaseState()
        {
            if (_targetGraphic != null) _baseGraphicColor = _targetGraphic.color;
            if (_targetText != null) _baseTextColor = _targetText.color;
            if (_targetRect != null)
            {
                _baseScale = _targetRect.localScale;
                _baseAnchoredPosition = _targetRect.anchoredPosition;
            }

            if (_targetShadow != null)
            {
                _baseShadowDistance = _targetShadow.effectDistance;
                _baseShadowColor = _targetShadow.effectColor;
            }

            _initialized = true;
        }

        private void EnsureDefaultStates()
        {
            // When the component is added via script, Reset is not guaranteed in all editor contexts.
            // Fill with safe defaults if states are still zeroed.
            if (_normalState.scaleMultiplier <= 0f) _normalState = UiVisualState.Default();
            if (_hoverState.scaleMultiplier <= 0f) _hoverState = UiVisualState.Default();
            if (_pressedState.scaleMultiplier <= 0f) _pressedState = UiVisualState.Default();
            if (_disabledState.scaleMultiplier <= 0f) _disabledState = UiVisualState.Default();
        }

        private void RestoreBaseState()
        {
            if (!_initialized) return;

            if (_targetGraphic != null) _targetGraphic.color = _baseGraphicColor;
            if (_targetText != null) _targetText.color = _baseTextColor;
            if (_targetRect != null)
            {
                _targetRect.localScale = _baseScale;
                _targetRect.anchoredPosition = _baseAnchoredPosition;
            }

            if (_targetShadow != null)
            {
                _targetShadow.effectDistance = _baseShadowDistance;
                _targetShadow.effectColor = _baseShadowColor;
            }
        }

        private bool IsInteractable()
        {
            return _selectable == null || _selectable.IsInteractable();
        }

        private UiVisualState ResolveState()
        {
            if (!IsInteractable()) return _disabledState;
            if (_pressed) return _pressedState;
            if (_hovered || _selected) return _hoverState;
            return _normalState;
        }

        private void ApplyCurrentState()
        {
            if (!_initialized) return;

            var state = ResolveState();
            if (_targetGraphic != null)
            {
                _targetGraphic.color = Multiply(_baseGraphicColor, state.graphicMultiplier);
            }

            if (_targetText != null)
            {
                _targetText.color = Multiply(_baseTextColor, state.textMultiplier);
            }

            if (_targetRect != null)
            {
                var scale = Mathf.Max(0.001f, state.scaleMultiplier);
                _targetRect.localScale = _baseScale * scale;
                _targetRect.anchoredPosition = _baseAnchoredPosition + state.positionOffset;
            }

            if (_targetShadow != null)
            {
                _targetShadow.effectDistance = _baseShadowDistance + state.shadowOffset;
                var shadow = _baseShadowColor;
                shadow.a *= Mathf.Max(0f, state.shadowAlphaMultiplier);
                _targetShadow.effectColor = shadow;
            }
        }

        private static Color Multiply(Color lhs, Color rhs)
        {
            return new Color(lhs.r * rhs.r, lhs.g * rhs.g, lhs.b * rhs.b, lhs.a * rhs.a);
        }
    }
}
