import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="mx-auto flex max-w-[1440px] flex-col gap-4 px-4 py-24 sm:px-8 lg:px-20">
      <span className="kicker">Not in the registry</span>
      <h1 className="font-serif text-6xl">There is no page here.</h1>
      <p className="max-w-xl text-lg text-ink2">The link may be mistyped, or point to something that was never filed.</p>
      <Link to="/" className="mt-4 inline-flex min-h-12 w-fit items-center bg-blue px-5 font-semibold text-white hover:bg-blue-deep">
        Back to the registry
      </Link>
    </section>
  );
}
