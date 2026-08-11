import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  motion,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import { BrandLockup, BrandMark } from "../components/BrandLockup";

const GITHUB_URL = "https://github.com/0xDevansh/lapis";
const DEPLOY_URL = `${GITHUB_URL}#deploy-your-own-lapis`;
const PLUGIN_URL = `${GITHUB_URL}#install-the-obsidian-plugin`;
const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
const ISSUES_URL = `${GITHUB_URL}/issues`;

const ease = [0.22, 1, 0.36, 1] as const;
const HEADER_SCROLL_THRESHOLD = 28;
/** Ignore tiny scroll jitter when deciding direction. */
const HEADER_DIR_DELTA = 6;

type HeaderMode = "top" | "visible" | "hidden";

function useReveal(): Variants {
  const reduce = useReducedMotion();
  if (reduce) {
    return {
      hidden: { opacity: 0 },
      show: { opacity: 1, transition: { duration: 0.2 } },
    };
  }
  return {
    hidden: { opacity: 0, y: 18 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.65, ease },
    },
  };
}

/** Top of page → ghost; scroll down → float in; keep scrolling down → float out; scroll up → float in again. */
function useHeaderMode(): HeaderMode {
  const [mode, setMode] = useState<HeaderMode>("top");
  const lastY = useRef(0);
  const modeRef = useRef<HeaderMode>("top");

  useEffect(() => {
    lastY.current = window.scrollY;

    const onScroll = () => {
      const y = window.scrollY;
      const prev = lastY.current;
      const delta = y - prev;
      lastY.current = y;

      let next: HeaderMode = modeRef.current;

      if (y <= HEADER_SCROLL_THRESHOLD) {
        next = "top";
      } else if (modeRef.current === "top") {
        // Crossed the fold — float in.
        next = "visible";
      } else if (delta > HEADER_DIR_DELTA) {
        // Scrolling down — float out.
        next = "hidden";
      } else if (delta < -HEADER_DIR_DELTA) {
        // Scrolling up — float back in.
        next = "visible";
      }

      if (next !== modeRef.current) {
        modeRef.current = next;
        setMode(next);
      }
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return mode;
}

function LandingHeader() {
  const mode = useHeaderMode();
  const reduce = useReducedMotion();
  const duration = reduce ? 0 : 0.4;
  const shown = mode === "visible";
  const solid = mode !== "top";

  return (
    <motion.header
      className="landing-header-font fixed inset-x-0 top-0 z-30"
      initial={false}
      animate={mode}
      variants={{
        top: {
          y: 0,
          backgroundColor: "transparent",
          borderBottomColor: "transparent",
          backdropFilter: "blur(0px)",
          pointerEvents: "none",
        },
        visible: {
          y: 0,
          backgroundColor: "color-mix(in srgb, var(--canvas) 72%, transparent)",
          borderBottomColor: "color-mix(in srgb, var(--ink) 8%, transparent)",
          backdropFilter: "blur(12px)",
          pointerEvents: "auto",
        },
        hidden: {
          y: "-100%",
          backgroundColor: "color-mix(in srgb, var(--canvas) 72%, transparent)",
          borderBottomColor: "color-mix(in srgb, var(--ink) 8%, transparent)",
          backdropFilter: "blur(12px)",
          pointerEvents: "none",
        },
      }}
      transition={mode === "top" ? { duration: 0 } : { duration, ease }}
      style={{
        borderBottomWidth: 1,
        borderBottomStyle: "solid",
        WebkitBackdropFilter: solid ? "blur(12px)" : "blur(0px)",
      }}
    >
      <div className="mx-auto flex h-14 max-w-[1075px] items-center justify-between px-5 sm:px-6">
        <motion.div
          initial={false}
          animate={
            shown
              ? { opacity: 1, y: 0 }
              : { opacity: 0, y: mode === "top" ? -10 : 0 }
          }
          transition={{ duration, ease }}
        >
          <Link to="/" className="flex items-center gap-2.5">
            <BrandMark size={22} />
            <span className="text-xl font-bold tracking-tight text-ink">
              Lapis
            </span>
          </Link>
        </motion.div>

        <motion.div
          className="flex items-center gap-2 sm:gap-3"
          initial={false}
          animate={
            shown
              ? { opacity: 1, y: 0 }
              : { opacity: 0, y: mode === "top" ? -10 : 0 }
          }
          transition={{
            duration,
            ease,
            delay: shown && !reduce ? 0.05 : 0,
          }}
        >
          <Link
            to="/auth"
            className="hidden px-2 py-1.5 text-[15px] font-medium text-muted transition-colors hover:text-ink sm:inline"
          >
            Sign in
          </Link>
          <Link
            to="/auth?mode=signup"
            className="landing-cta bg-accent text-on-accent hover:bg-accent-soft"
          >
            Open Lapis
          </Link>
        </motion.div>
      </div>
    </motion.header>
  );
}

function VaultMock({ className = "" }: { className?: string }) {
  return (
    <div
      className={`overflow-hidden rounded-lg border border-border bg-secondary shadow-[0_24px_80px_var(--shadow)] ${className}`}
      aria-hidden
    >
      <div className="flex h-9 items-center gap-2 border-b border-border bg-canvas px-3">
        <span className="h-2.5 w-2.5 rounded-full bg-danger/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-success/80" />
        <span className="ml-3 font-mono text-[11px] text-faint">
          Periodic Notes / 2022-10-13.md
        </span>
      </div>
      <div className="grid min-h-[280px] grid-cols-[132px_1fr] sm:min-h-[340px] sm:grid-cols-[168px_1fr]">
        <aside className="border-r border-border bg-secondary p-2.5 text-[12px]">
          <div className="mb-2 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
            Vault
          </div>
          <div className="space-y-0.5 text-muted">
            <div className="rounded px-1.5 py-1">Areas</div>
            <div className="rounded px-1.5 py-1">Projects</div>
            <div className="rounded bg-accent/20 px-1.5 py-1 font-medium text-ink">
              2022-10-13
            </div>
            <div className="rounded px-1.5 py-1">Inbox</div>
          </div>
        </aside>
        <article className="bg-canvas px-5 py-6 sm:px-8 sm:py-8">
          <h3 className="landing-title mb-3 text-xl text-ink sm:text-2xl">
            Thursday, October 13
          </h3>
          <p className="landing-body mb-3 text-muted">
            Synced from Obsidian. Opened here from the phone — waiting on the
            desk when I get home.
          </p>
          <p className="mb-4 text-sm text-ink">
            See{" "}
            <span className="text-accent-soft underline decoration-accent-soft/40">
              [[Weekly review]]
            </span>{" "}
            and <span className="tag-pill">#Cadence/Daily</span>
          </p>
          <div className="rounded border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent-soft">
            <span className="font-medium">Note</span> — private by default; your
            Cloudflare, your vault.
          </div>
          <span className="landing-caret mt-4 inline-block h-4 w-0.5 bg-accent-soft align-middle" />
        </article>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const reveal = useReveal();
  const reduce = useReducedMotion();

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink antialiased">
      <LandingHeader />

      {/* Hero — top padding clears the fixed CTA without a solid bar */}
      <section className="landing-hero-glow relative overflow-hidden">
        <div className="landing-hero-orbs" aria-hidden>
          <div className="landing-hero-orb landing-hero-orb-a" />
          <div className="landing-hero-orb landing-hero-orb-b" />
        </div>
        <div className="relative z-[2] mx-auto grid max-w-6xl items-center gap-10 px-5 pb-20 pt-20 sm:px-8 lg:grid-cols-[1fr_1.15fr] lg:gap-12 lg:pb-28 lg:pt-24">
          <div className="relative z-10">
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease }}
              className="mb-6"
            >
              <BrandMark
                size={52}
                className="drop-shadow-[0_0_28px_var(--hero-glow)]"
              />
            </motion.div>
            <motion.h1
              initial={reduce ? false : { opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.75, delay: 0.06, ease }}
              className="landing-display mb-5 text-[40px] text-ink sm:text-[48px] sm:leading-[51px]"
            >
              <span className="block">Your Obsidian vault,</span>
              <span className="block">anywhere.</span>
            </motion.h1>
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, delay: 0.14, ease }}
              className="landing-body mb-8 max-w-md space-y-1"
            >
              <p className="text-ink">
                Browse, edit, and search from any browser.
              </p>
              <p className="text-muted">
                Self-hosted on Cloudflare. Syncs both ways with Obsidian.
              </p>
            </motion.div>
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.22, ease }}
              className="flex flex-col items-start gap-3"
            >
              <div className="flex flex-wrap items-center gap-2.5">
                <Link
                  to="/auth?mode=signup"
                  className="landing-cta bg-accent text-on-accent hover:bg-accent-soft"
                >
                  Open Lapis
                </Link>
                <a
                  href={DEPLOY_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="landing-cta border border-border-strong bg-elevated text-ink hover:border-accent/50 hover:text-accent-soft"
                >
                  Deploy your own
                </a>
              </div>
              <p className="text-[13px] text-faint">
                Runs on Cloudflare&apos;s free tier. Your vault, your account.
              </p>
            </motion.div>
          </div>

          <motion.div
            initial={reduce ? false : { opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.9, delay: 0.1, ease }}
            className="relative z-0 lg:justify-self-end"
          >
            <VaultMock className="w-full max-w-xl lg:max-w-none" />
          </motion.div>
        </div>
      </section>

      {/* Open a note */}
      <motion.section
        className="border-t border-border px-5 py-20 sm:px-8 sm:py-28"
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.25 }}
        variants={reveal}
      >
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="landing-title mb-3 text-[32px] text-ink md:text-[40px]">
            Open a note from anywhere
          </h2>
          <p className="landing-body mx-auto max-w-xl text-muted">
            Wikilinks, callouts, tags, and backlinks in the browser — no Obsidian
            install required on the machine you happen to be on.
          </p>
        </div>
      </motion.section>

      {/* Sync */}
      <motion.section
        className="border-t border-border bg-secondary/40 px-5 py-20 sm:px-8 sm:py-28"
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.25 }}
        variants={reveal}
      >
        <div className="mx-auto max-w-4xl">
          <div className="mb-12 text-center">
            <h2 className="landing-title mb-3 text-[32px] text-ink md:text-[40px]">
              Two-way sync with Obsidian
            </h2>
            <p className="landing-body mx-auto max-w-xl text-muted">
              A plugin keeps your local vault and web vault in sync. Offline
              change tracking. Graceful conflict resolution.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-center sm:gap-0">
            <SyncPane label="Obsidian" sub="Local vault on your device" />
            <div className="flex items-center justify-center px-2 sm:px-4">
              <div className="landing-sync-line h-px w-16 bg-accent sm:h-16 sm:w-px" />
              <span className="mx-2 font-mono text-[11px] uppercase tracking-widest text-accent-soft">
                plugin
              </span>
              <div className="landing-sync-line h-px w-16 bg-accent sm:h-16 sm:w-px" />
            </div>
            <SyncPane label="Lapis" sub="Web vault on Cloudflare" accent />
          </div>
        </div>
      </motion.section>

      {/* Private */}
      <motion.section
        className="border-t border-border px-5 py-20 sm:px-8 sm:py-28"
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.3 }}
        variants={reveal}
      >
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="landing-title mb-3 text-[32px] text-ink md:text-[40px]">
            Private by default
          </h2>
          <p className="landing-body text-muted">
            Password protected. Deploy your own instance on Cloudflare if you
            want the keys entirely in your hands.
          </p>
        </div>
      </motion.section>

      {/* Close CTA */}
      <motion.section
        className="border-t border-border px-5 py-20 sm:px-8 sm:py-24"
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.35 }}
        variants={reveal}
      >
        <div className="mx-auto flex max-w-xl flex-col items-center text-center">
          <BrandLockup
            size={32}
            className="mb-5"
            textClassName="text-2xl font-bold tracking-tight text-ink"
          />
          <p className="landing-body mb-8 text-muted">
            Open Lapis in the browser, or deploy your own instance.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <Link
              to="/auth?mode=signup"
              className="landing-cta bg-accent text-on-accent hover:bg-accent-soft"
            >
              Open Lapis
            </Link>
            <a
              href={DEPLOY_URL}
              target="_blank"
              rel="noreferrer"
              className="landing-cta border border-border-strong bg-elevated text-ink hover:border-accent/50 hover:text-accent-soft"
            >
              Deploy your own
            </a>
          </div>
        </div>
      </motion.section>

      {/* Multi-column footer — YAOS structure, Lapis tokens */}
      <footer className="landing-footer mt-auto w-full">
        <div className="mx-auto w-full max-w-[1075px] px-6 py-12">
          <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-5">
              <Link to="/" className="flex items-center gap-2.5">
                <BrandMark size={18} />
                <span className="text-xl font-bold tracking-tight text-ink">
                  Lapis
                </span>
              </Link>
              <p className="text-sm text-faint">
                Your Obsidian vault, anywhere.
              </p>
              <p className="text-sm text-faint">
                Open source ·{" "}
                <a
                  href={LICENSE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted underline underline-offset-2 transition-colors hover:text-ink"
                >
                  MIT
                </a>
              </p>
              <div className="flex items-center gap-4 text-faint">
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="transition-colors hover:text-muted"
                  aria-label="GitHub"
                >
                  <GitHubIcon />
                </a>
              </div>
            </div>

            <FooterCol
              title="Product"
              links={[
                { label: "Open Lapis", to: "/auth?mode=signup" },
                { label: "Sign in", to: "/auth" },
                { label: "Deploy your own", href: DEPLOY_URL },
              ]}
            />
            <FooterCol
              title="Setup"
              links={[
                { label: "Install plugin", href: PLUGIN_URL },
                { label: "Documentation", href: GITHUB_URL },
                { label: "Self-hosting", href: `${GITHUB_URL}/tree/main/docs` },
              ]}
            />
            <FooterCol
              title="Project"
              links={[
                { label: "Source code", href: GITHUB_URL },
                { label: "Report an issue", href: ISSUES_URL },
                { label: "MIT License", href: LICENSE_URL },
              ]}
            />
          </div>

          <div className="mt-12 flex flex-col gap-3 border-t border-border pt-8">
            <p className="text-sm text-faint">© {new Date().getFullYear()} Lapis · MIT</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { label: string; href?: string; to?: string }[];
}) {
  return (
    <div>
      <div className="landing-footer-heading">{title}</div>
      <ul className="mt-5 flex flex-col gap-3">
        {links.map((link) => (
          <li key={link.label}>
            {link.to ? (
              <Link to={link.to} className="landing-footer-link">
                {link.label}
              </Link>
            ) : (
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="landing-footer-link"
              >
                {link.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SyncPane({
  label,
  sub,
  accent = false,
}: {
  label: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`flex-1 rounded-lg border px-5 py-6 text-center sm:max-w-[240px] ${
        accent ? "border-accent/40 bg-accent/10" : "border-border bg-surface"
      }`}
    >
      <div className="mb-1 text-sm font-semibold text-ink">{label}</div>
      <div className="font-mono text-[11px] text-muted">{sub}</div>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.1 0 0 .67-.22 2.2.82a7.54 7.54 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.09.16 1.9.08 2.1.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
