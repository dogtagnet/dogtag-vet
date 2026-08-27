import {Banner} from "@/components/ui/Banner";

/** Placeholder body for a nav destination whose feature ships in a later stage of this build
 * (see plans/wp4-vet.md) - keeps every sidebar link live rather than 404ing while the app is
 * built out incrementally. */
export function ComingSoon({feature}: {feature: string}) {
  return (
    <div className="mx-auto max-w-2xl">
      <Banner tone="info" title={`${feature} is not built yet`}>
        This area ships in a later stage of the dogtag-vet build.
      </Banner>
    </div>
  );
}
