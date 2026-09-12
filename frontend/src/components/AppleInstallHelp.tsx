import { Share } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function AppleInstallHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="w-[calc(100%-2rem)] max-w-lg">
      <DialogHeader>
        <DialogTitle>Add Ops Center to your Home Screen</DialogTitle>
        <DialogDescription>On iPhone and iPad, installation is available through your browser&apos;s Share menu.</DialogDescription>
      </DialogHeader>
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li>Open Ops Center directly in <strong>Safari or Chrome</strong>.</li>
        <li>Tap the browser&apos;s <strong>Share</strong> button <Share className="inline h-4 w-4" aria-label="Square with an upward arrow" /> near the address bar. In Safari, tap <strong>More</strong> if shown.</li>
        <li>Scroll the share menu and choose <strong>Add to Home Screen</strong>.</li>
        <li>Enable <strong>Open as Web App</strong> if shown, then tap <strong>Add</strong>. Start Ops Center using the new Home Screen icon.</li>
      </ol>
      <p className="text-sm text-muted-foreground">This guide does not open the system installation dialog. Use the browser&apos;s Share button to finish. You may need to sign in again in the installed app.</p>
      <details className="rounded-lg border border-border p-3 text-sm">
        <summary className="cursor-pointer font-medium">Cannot find Add to Home Screen?</summary>
        <div className="mt-3 space-y-3 text-muted-foreground">
          <p>Open the address below in a regular Safari tab, outside an embedded browser in another app. Check the full Share menu, including More if available.</p>
          <input aria-label="Ops Center app link" readOnly value={new URL("/", window.location.href).href}
            className="w-full rounded-md border border-border bg-background px-2 py-2 text-foreground" onFocus={event => event.currentTarget.select()} />
          <p>Chrome needs a supported browser version and iOS/iPadOS 16.4 or later for this action. If Safari also has no action, check the iPadOS version and whether the device uses Shared iPad mode, which can prevent adding Home Screen apps. A website cannot enable a missing system action.</p>
          <p><a className="text-primary underline" href="https://support.apple.com/guide/ipad/ipad8f1f7a29/ipados" target="_blank" rel="noreferrer">Apple instructions</a>{" · "}
            <a className="text-primary underline" href="https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS&amp;hl=en" target="_blank" rel="noreferrer">Chrome instructions</a></p>
        </div>
      </details>
      <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
    </DialogContent>
  </Dialog>;
}
