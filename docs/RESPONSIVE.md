# Responsive support — 320px & 375px

Cook Mitra's frontend is a hand-rolled CSS design system (no Tailwind / CSS-in-JS):
all styles live in `frontend/src/styles/*.css` and are imported in order by
`frontend/src/App.css`. Responsive behaviour is therefore driven entirely by
`@media` blocks in those stylesheets.

## The two smallest tiers we support

| Tier | Viewport | Typical devices |
| --- | --- | --- |
| `375px` | `@media (max-width: 375px)` | iPhone SE 2/3, iPhone 12/13 mini, most Android handsets (portrait) |
| `320px` | `@media (max-width: 320px)` | iPhone SE 1st gen, Galaxy Fold outer screen — the hard floor |

Both are **additive `max-width` tiers**, so they only ever apply *below* the
existing `400 / 380 / 360 / 480 / 560 / 640 / 768 …` blocks and cannot regress a
larger viewport.

## Where the rules live (colocated + safety net)

Component-specific rules sit in **the stylesheet that owns the component's base
styles**, right after that file's `≤400px` block — matching the repo's existing
colocated convention. Cross-cutting rules (type rhythm, overlay insets, overflow
and tap-target floors) live in one **"Small-phone safety net"** section at the
bottom of `frontend/src/styles/responsive.css`.

Every sheet has a `≤375px` (and where warranted `≤320px`) block:

- Shell / primitives: `base.css`, `navbar.css`, `buttons.css`, `forms.css`,
  `pickers.css`, `feedback.css`, `notifications.css`, `misc.css`, `responsive.css`
- Auth: `auth.css`
- Home / marketing: `home-hero.css`, `home-hero-right.css`, `home-sections.css`,
  `home-sections-2.css`, `home-coupons.css`, `festive-offer.css`,
  `dish-carousel.css`
- Cook & booking: `cooks.css`, `cook-components.css`, `cook-pages.css`,
  `booking.css`, `booking-flow.css`, `booking-pay.css`, `review-form.css`
- Dashboards / admin: `dashboards.css`, `coupons-admin.css`

## Non-negotiable floors (never regress these)

1. **No horizontal overflow** — `document.documentElement.scrollWidth` must equal
   `window.innerWidth` at every supported width.
2. **Tap targets ≥ 40px** tall for every interactive control (WCAG 2.5.8).
3. **Inputs stay 16px** on touch so iOS Safari never zooms on focus.
4. **Grids never overflow** — every `minmax(NNNpx, 1fr)` floor is wrapped as
   `minmax(min(100%, NNNpx), 1fr)` so an auto-fit grid collapses to one column
   instead of spilling off-screen.

## QA matrix

Run the app (`npm start` in `frontend/`) and, in DevTools device toolbar, walk
every route at **320×568, 320×480, 375×667, 375×812** plus **375/320 landscape**:

`/`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/cooks`,
`/cooks/:id`, `/booking`, `/bookings/:id`, `/bookings/:id/wait`,
`/bookings/:id/pay`, `/dashboard/my-bookings`, `/dashboard/profile`,
`/dashboard/cook-bookings`, `/dashboard/cook-profile`, `/dashboard/cook-reviews`,
`/admin`, `/admin/cooks/:id`, `/admin/complaints`, and the legal pages.

For each, confirm (a) no horizontal scroll, (b) all tap targets ≥ 40px,
(c) nothing clipped or overlapping, (d) inputs don't trigger iOS zoom.
Then spot-check `400 / 480 / 640` to be sure nothing leaked upward.

## Build gate

`cd frontend && npm run build` must stay clean — it is part of the deploy
pipeline (`Dockerfile`, `render.yaml`, `Jenkinsfile`).