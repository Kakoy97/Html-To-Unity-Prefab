using UnityEngine;

namespace HtmlToPrefab.Runtime
{
    [DisallowMultipleComponent]
    public sealed class UiNodeRef : MonoBehaviour
    {
        [SerializeField] private string _nodeId = string.Empty;
        [SerializeField] private string _nodeType = string.Empty;
        [SerializeField] private string _htmlTag = string.Empty;
        [SerializeField] private string _role = string.Empty;
        [SerializeField] private string _inputType = string.Empty;
        [SerializeField] private string _domPath = string.Empty;

        public string NodeId => _nodeId;
        public string NodeType => _nodeType;
        public string HtmlTag => _htmlTag;
        public string Role => _role;
        public string InputType => _inputType;
        public string DomPath => _domPath;

        public void Initialize(
            string nodeId,
            string nodeType,
            string htmlTag,
            string role,
            string inputType,
            string domPath
        )
        {
            _nodeId = nodeId ?? string.Empty;
            _nodeType = nodeType ?? string.Empty;
            _htmlTag = htmlTag ?? string.Empty;
            _role = role ?? string.Empty;
            _inputType = inputType ?? string.Empty;
            _domPath = domPath ?? string.Empty;
        }
    }
}
