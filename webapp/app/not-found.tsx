import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center p-10 text-center">
      <div>
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl gemini-gradient text-2xl text-white">
          ✦
        </div>
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          That conversation or page doesn&apos;t exist. It may have been removed from your local
          archive.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg gemini-gradient px-5 py-2.5 text-sm font-medium text-white transition-[filter] hover:brightness-110"
        >
          Back to archive
        </Link>
      </div>
    </div>
  );
}
