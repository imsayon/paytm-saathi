export default function Template({ children }: { children: React.ReactNode }) {
  // Re-mounts on every navigation, so each screen slides in.
  return <div className="page">{children}</div>;
}
