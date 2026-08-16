/* A silhouette of the result card in GateTerminal — same 44-unit avatar box and
   the same three text rows — so the real result lands in place instead of
   appearing out of nothing.

   Purely decorative: aria-hidden keeps it out of the accessibility tree, and
   the callers announce the actual state in text. */
export default function GateCardSkeleton({ idle = false }: { idle?: boolean }) {
  const block = `skeleton ${idle ? "skeleton-idle" : ""}`;

  return (
    <div
      aria-hidden
      className={`flex items-center justify-center gap-8 transition-opacity duration-500 ${
        idle ? "opacity-35" : "opacity-80"
      }`}
    >
      <div className={`h-44 w-44 shrink-0 rounded-2xl ${block}`} />
      <div className="w-72 space-y-4">
        <div className={`h-10 w-full rounded-xl ${block}`} />
        <div className={`h-6 w-2/3 rounded-lg ${block}`} />
        <div className={`h-5 w-1/2 rounded-lg ${block}`} />
      </div>
    </div>
  );
}
