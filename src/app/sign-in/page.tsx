import {getServerEnv, isDevLoginEnabled} from "@/lib/env";
import {Button, Input} from "@/components/ui/controls";
import {FormField} from "@/components/ui/FormSection";
import {Banner} from "@/components/ui/Banner";
import {ThemeToggle} from "@/components/ui/ThemeToggle";
import {signInWithDevLogin, signInWithEmail, signInWithGoogle} from "@/app/sign-in/actions";

export default async function SignInPage({searchParams}: {searchParams: Promise<{error?: string}>}) {
  const {error} = await searchParams;
  const env = getServerEnv();
  const googleEnabled = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
  const emailEnabled = Boolean(env.EMAIL_SERVER && env.EMAIL_FROM);
  const devLoginEnabled = isDevLoginEnabled();

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-card border border-border bg-surface p-6 shadow-card">
        <h1 className="mb-1 text-section-title text-ink">Staff sign in</h1>
        <p className="mb-6 text-body text-ink-muted">Access this clinic&apos;s dogtag-vet deployment.</p>

        {error === "AccessDenied" && (
          <div className="mb-4">
            <Banner tone="danger" title="This email is not authorized for this deployment">
              Ask an owner to invite this address from Settings, then try again.
            </Banner>
          </div>
        )}

        <div className="space-y-4">
          {googleEnabled && (
            <form action={signInWithGoogle}>
              <Button type="submit" variant="secondary" className="w-full">
                Continue with Google
              </Button>
            </form>
          )}

          {emailEnabled && (
            <form action={signInWithEmail} className="space-y-3">
              <FormField label="Email" htmlFor="email-magic-link" helperText="We'll send you a one-time sign-in link.">
                <Input id="email-magic-link" name="email" type="email" required placeholder="you@clinic.example" />
              </FormField>
              <Button type="submit" className="w-full">
                Send magic link
              </Button>
            </form>
          )}

          {devLoginEnabled && (
            <div className="space-y-3 border-t border-border pt-4">
              <Banner tone="warn" title="Dev login is enabled">
                DEV_LOGIN=1 is set. Never enable this in a production deployment.
              </Banner>
              <form action={signInWithDevLogin} className="space-y-3">
                <FormField label="Email" htmlFor="email-dev-login">
                  <Input id="email-dev-login" name="email" type="email" required placeholder="you@clinic.example" />
                </FormField>
                <Button type="submit" variant="secondary" className="w-full">
                  Dev sign in (test only)
                </Button>
              </form>
            </div>
          )}

          {!googleEnabled && !emailEnabled && !devLoginEnabled && (
            <Banner tone="danger" title="No sign-in method is configured">
              Set Google OAuth or SMTP credentials, or DEV_LOGIN=1 for local development. See
              .env.example.
            </Banner>
          )}
        </div>
      </div>
    </div>
  );
}
