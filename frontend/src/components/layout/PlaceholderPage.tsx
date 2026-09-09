import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface PlaceholderPageProps {
  title: string;
  phase: string;
}

export function PlaceholderPage({ title, phase }: PlaceholderPageProps) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Not yet implemented</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          This page is planned for {phase} of the Ops Center build-out.
        </CardContent>
      </Card>
    </div>
  );
}
