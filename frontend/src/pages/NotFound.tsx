import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">This page doesn't exist</h1>
      <p className="text-muted-foreground">The address may be old or mistyped. Use the menu to find a feature, or go back to the overview.</p>
      <Link to="/" className="inline-block text-sm text-primary hover:underline">Go to Overview</Link>
    </div>
  );
}
