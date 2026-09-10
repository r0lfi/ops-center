import { useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, Search } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { documentation } from "@/lib/ai-documentation";

export default function AIDocumentation() {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase("nb");
  const sections = documentation.filter((section) =>
    [section.title, ...section.paragraphs, ...(section.rows?.flat() ?? []), ...section.sources]
      .join(" ").toLocaleLowerCase("nb").includes(normalized),
  );

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <BookOpen className="h-7 w-7 text-primary" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">Ops Center – teknisk dokumentasjon</h1>
        </div>
        <p className="max-w-4xl text-sm leading-6 text-muted-foreground">
          Plattformen, AI-agentene og infrastrukturen som ligger i bunnen. Kodegjennomgang:
          10. september 2026, offentlig kildekode. Dette er versjonert dokumentasjon;
          modellvalg, agenttilganger og driftsstatus kan endres etter publisering.
        </p>
        <div className="flex flex-wrap gap-4 text-sm text-primary">
          <Link className="underline underline-offset-4" to="/ai-agents/agents">Agentkonfigurasjon</Link>
          <Link className="underline underline-offset-4" to="/ai-agents/settings">Modellleverandører</Link>
          <Link className="underline underline-offset-4" to="/ai-agents/approvals">Godkjenninger</Link>
          <Link className="underline underline-offset-4" to="/ai-agents/memory">Historikk og minne</Link>
        </div>
      </div>
      <div className="relative max-w-xl">
        <label className="sr-only" htmlFor="documentation-search">Søk i dokumentasjonen</label>
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <Input id="documentation-search" type="search" className="pl-9" value={query}
          onChange={(event) => setQuery(event.target.value)} placeholder="Søk etter runtime, minne, Docker, godkjenning …" />
      </div>
      <p className="text-xs text-muted-foreground" role="status">{sections.length} av {documentation.length} kapitler</p>
      <div className="grid items-start gap-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        <nav aria-label="Innhold i dokumentasjonen" className="rounded-lg border border-border p-4 lg:sticky lg:top-4">
          <p className="mb-3 text-sm font-semibold">Innhold</p>
          <ol className="space-y-2 text-sm">
            {sections.map((section) => <li key={section.id}>
              <a className="block rounded text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" href={`#${section.id}`}>{section.title}</a>
            </li>)}
          </ol>
        </nav>
        <div className="min-w-0 space-y-5">
          {sections.length === 0 && <p className="rounded-lg border border-border p-6 text-sm">Ingen kapitler passer søket. Prøv et annet ord eller tøm søkefeltet.</p>}
          {sections.map((section) => (
            <Card key={section.id} id={section.id} className="scroll-mt-6">
              <CardHeader><h2 className="text-lg font-semibold">{section.title}</h2></CardHeader>
              <CardContent className="space-y-4 text-sm leading-6">
                {section.paragraphs.map((paragraph) => <p key={paragraph} className="text-muted-foreground">{paragraph}</p>)}
                {section.flow && <ol aria-label="Dataflyt" className="grid gap-2 sm:grid-cols-2">
                  {section.flow.map((step, index) => <li key={step} className="rounded-md border border-border bg-secondary/40 p-3">
                    <span className="mr-2 font-semibold text-primary">{index + 1} →</span>{step}
                  </li>)}
                </ol>}
                {section.rows && <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">{section.title}</caption>
                    <thead className="bg-secondary"><tr>{section.columns?.map((column) => <th key={column} scope="col" className="px-4 py-2 font-medium">{column}</th>)}</tr></thead>
                    <tbody>{section.rows.map((row) => <tr key={row[0]} className="border-t border-border">
                      {row.map((cell, index) => index === 0
                        ? <th key={index} scope="row" className="px-4 py-3 align-top font-medium">{cell}</th>
                        : <td key={index} className="min-w-48 px-4 py-3 align-top text-muted-foreground">{cell}</td>)}
                    </tr>)}</tbody>
                  </table>
                </div>}
                <div className="border-t border-border pt-3 text-xs text-muted-foreground">
                  <p className="mb-1 font-medium">Kildegrunnlag i prosjektet</p>
                  <ul className="space-y-1">{section.sources.map((source) => <li key={source}><code className="break-all">{source}</code></li>)}</ul>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
