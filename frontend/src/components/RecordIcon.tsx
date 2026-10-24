export function RecordIcon({ kind }: { kind: 'task' | 'message' | 'execution' }) {
  return (
    <span className={`record-icon ${kind}`} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === 'message' ? (
          <>
            <path d="M5 5h14v10H9l-4 4V5Z" />
            <path d="M8 9h8M8 12h5" />
          </>
        ) : kind === 'execution' ? (
          <>
            <rect x="4" y="4" width="16" height="16" rx="3" />
            <path d="m10 8 6 4-6 4V8Z" />
          </>
        ) : (
          <>
            <rect x="5" y="5" width="14" height="16" rx="2" />
            <path d="M9 3h6v4H9zM9 12h6M9 16h4" />
          </>
        )}
      </svg>
    </span>
  );
}
