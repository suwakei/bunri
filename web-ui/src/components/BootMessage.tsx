/**
 * bunri DAW — 起動待ち・起動失敗の表示。
 * デスクトップ版で、Python sidecar が待ち受けを始めるまでの間と、起動できなかったときに出す。
 */

/** 起動待ち・起動失敗のときに出す、最小限の表示。 */
export default function BootMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div style={{ padding: 32, fontFamily: 'sans-serif', color: '#e8e4de', background: '#111116', minHeight: '100vh' }}>
      <p style={{ fontSize: 16 }}>{title}</p>
      {detail && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.8 }}>{detail}</pre>}
    </div>
  );
}
