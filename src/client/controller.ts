/**
 * DOM-side mobile controller: the non-React half of the plugin. Owns the
 * pieces the frame itself cannot express — the viewport meta upgrade, the
 * safe-area/keyboard CSS variables, and the pager's live state (page mirror,
 * 3D flip vars, click-to-return). Everything it installs is removed by
 * dispose(), and every rule it depends on is scoped under the
 * [data-dsh-mobile] attribute it sets on <html>.
 *
 * Mobile layout follows PiUI's chat pager: the STOCK AppFrame becomes a
 * horizontal scroll-snap pager whose columns are two pages — an always-open
 * sidebar page and a full-width chat page. The frame's own state is only
 * touched to expand the auto-collapsed sidebar ONCE below the breakpoint
 * (AppFrame collapses it to the rail on narrow viewports); from then on the
 * pager position is fully user-driven: the app starts on the chat page,
 * a click on the exposed chat card flips back to it, and picking a session
 * in the sidebar returns to it. The sidebar column keeps its full content
 * rendered at all times (a swipe is never state-synced, so it never
 * re-renders).
 */

/** The narrow breakpoint the pager keys off (PiUI's 768px). */
export const MOBILE_BREAKPOINT = '(max-width: 768px)'

/** The <html> attribute that mirrors the pager page the frame is resting on. */
export const PAGE_ATTR = 'data-dshm-page'

/** Pager page names (the mirror values of PAGE_ATTR). */
export type MobilePage = 'sidebar' | 'chat'

/** Wait after the last scroll event before the pager settles. */
const SCROLL_SETTLE_MS = 200

/** Poll interval for the return-to-chat smoother. The smooth scroll is only
 *  re-issued when it is actually STALLED (scrollLeft stopped advancing),
 *  never pre-empted while it is in flight — so a retry reads as a natural
 *  continuation, and the pager is never snapped to the chat page. */
const SMOOTH_RETRY_MS = 160

/** Window (ms) after a session pick during which automatic focus into the
 *  composer is bounced back out: picking a session in the sidebar lands
 *  focus on the input, which pops the OS keyboard over the pager's smooth
 *  return-to-chat. On phones the keyboard must not open until the user
 *  actually taps the input — the focus is suppressed (blurred) during this
 *  window, so the return scroll runs undisturbed. */
const FOCUS_SUPPRESS_MS = 600

/** A focusin is judged "the user's own tap" only when a pointerdown landed
 *  on the same element within this recent window (a real tap intent).
 *  Older pointerdowns (e.g. the session row the user just tapped) must not
 *  count. */
const POINTER_ALLOW_MS = 500

/** The sidebar shell's collapse toggle labels (zh / en) — clicking it while
 *  the sidebar is expanded must NOT collapse it to the rail (which would
 *  unload its content); it flips back to the chat page instead. */
const SIDEBAR_COLLAPSE_LABELS = new Set(['收起侧边栏', 'Collapse sidebar'])

/**
 * Viewport meta content: maximum-scale blocks the iOS focus zoom that would
 * otherwise fight the fixed-height mobile layout; viewport-fit=cover exposes
 * the safe-area insets to env().
 */
const VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'

/**
 * The AppFrame keeps at least one of its two data attributes in every state
 * (a closed sidebar renders the rail, a closed details column renders zero
 * width), so the union always selects the frame and never a descendant. The
 * attributes identify the frame wherever it sits in the tree — rc.5 wraps
 * the frame in an extra shell div, so no `#root >` child prefix is assumed.
 */
const FRAME_SELECTOR = 'div[data-sidebar-collapsed], div[data-details-collapsed]'

/** The AppFrame element, or null before the layout entry mounts it. */
function findFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FRAME_SELECTOR)
}

/**
 * The composer's model-name label (the first span of the model TRIGGER
 * button — pinned via aria-haspopup='menu' so the open picker's option
 * rows, whose first span is a flex-column optionCopy, are never mistaken
 * for it). Its overflow drives the marquee: the controller measures
 * scrollWidth - clientWidth, wraps a double copy of the text (each in its
 * own item span) and tags the label with data-dshm-marquee + duration —
 * mobile.css's dshm-marquee keyframes slide the runner by -50% (one text
 * width + one gap) on the compositor, so the tail exits, a gap passes,
 * then the head re-enters: a classic spaced ticker, clipped inside the
 * label so it can never overlap the effort badge or the context ring.
 */
const MODEL_LABEL_SELECTOR =
  "[data-composer-card] [data-slot='conversation.input.model'] button[aria-haspopup='menu'] > span:first-child"

/**
 * The gap between marquee repetitions (px): one copy slides out, this
 * blank space passes, then the head re-enters. Must match the item span's
 * padding-right in mobile.css.
 */
const MARQUEE_GAP_PX = 32

/**
 * The pager's chat-page snap position: the rendered width of the sidebar
 * page column (the always-open card). Falls back to the frame's own width
 * while the layout has not settled (offsetWidth is 0 before first layout).
 */
function chatPageLeft(frame: HTMLElement): number {
  const sidebar = frame.firstElementChild
  if (sidebar instanceof HTMLElement && sidebar.offsetWidth > 0) return sidebar.offsetWidth
  return frame.clientWidth
}

/** Callbacks the controller needs from the apply world. */
export interface MobileControllerOptions {
  /** Toggle the sidebar panel (frame-owned layout action). */
  toggleSidebar: () => void
}

/** Test-facing surface of the controller (the class keeps everything else private). */
export interface MobileControllerHandle {
  /** True while the frame shows the sidebar expanded (not the rail). */
  isSidebarOpen(): boolean
  /** Return to the chat page (a session picked in the sidebar). */
  returnToChat(): void
  /** Install the controller; idempotent. */
  mount(): void
  /** Remove every DOM effect; idempotent. */
  dispose(): void
}

/** The DOM-side controller (see module doc). */
export class MobileController implements MobileControllerHandle {
  readonly #options: MobileControllerOptions
  #html: HTMLElement | null = null
  #mql: MediaQueryList | null = null
  #frameObserver: MutationObserver | null = null
  #rootObserver: MutationObserver | null = null
  #composerObserver: MutationObserver | null = null
  #marqueeLabel: HTMLElement | null = null
  #marqueeRO: ResizeObserver | null = null
  #marqueeFrame: number | null = null
  #viewportMeta: HTMLMetaElement | null = null
  #viewportOriginal: string | null = null
  #keyboardFrame: number | null = null
  #mountFrame: number | null = null
  #resizeTimer: number | null = null
  #settleTimer: number | null = null
  #returnTimer: number | null = null
  /** Last seen window.innerWidth — the resize handler only re-anchors the
   *  pager when the WIDTH changed (rotation / split-screen reflows the page
   *  tracks). A height-only resize (OS keyboard pop, URL bar collapse) must
   *  never touch scrollLeft: re-anchoring there can cancel the smooth
   *  return-to-chat that a session pick just started. */
  #lastInnerWidth = -1
  /** Timestamp until which automatic focus into the composer is kicked back
   *  out (see FOCUS_SUPPRESS_MS). */
  #focusSuppressUntil = -1
  /** The most recent pointerdown target + time, used to tell the user's own
   *  tap on the composer from the app's automatic focus. */
  #lastPointerTarget: Element | null = null
  #lastPointerAt = -1
  #expandPending = false
  #mounted = false
  #disposed = false

  /** @param options - apply-world callbacks. */
  constructor(options: MobileControllerOptions) {
    this.#options = options
  }

  /** True while the frame shows the sidebar expanded (not the rail). */
  isSidebarOpen(): boolean {
    const frame = findFrame()
    return frame !== null && !frame.hasAttribute('data-sidebar-collapsed')
  }

  /** Return to the chat page (a session picked in the sidebar). Pure scroll —
   *  the sidebar state is untouched, so its content stays rendered. */
  returnToChat(): void {
    // On phones, picking a session must NOT pop the OS keyboard: the app
    // auto-focuses the composer, and that keyboard would cover the pager's
    // smooth return-to-chat (and usually stalls it). Enter the focus
    // suppression window on mobile only — the desktop behavior (focus the
    // input after a session pick) stays untouched because the desktop
    // still wants to type straight away.
    if (this.#mql?.matches ?? false) {
      this.#focusSuppressUntil = Date.now() + FOCUS_SUPPRESS_MS
    }
    this.#redirectToChat()
  }

  /** Smoothly scroll the pager back to the chat page. The smooth scroll is
   *  re-issued ONLY when it is genuinely stalled (scrollLeft stops
   *  advancing across a poll) — the rare browser/OS cancellation case —
   *  and every re-issue is also smooth, so the retry never reads as an
   *  instant jump: the user always sees a natural slide back to the
   *  session. While the animation is in flight (or has landed) the poll is
   *  a no-op. */
  readonly #redirectToChat = (): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    this.#placeOnChat('smooth')
    if (this.#returnTimer !== null) window.clearTimeout(this.#returnTimer)
    let last = frame.scrollLeft
    const poll = (): void => {
      this.#returnTimer = null
      const f = findFrame()
      const mm = this.#mql?.matches ?? false
      if (f === null || !mm) return
      const cl = chatPageLeft(f)
      if (cl <= 0) return
      if (f.scrollLeft >= cl - 4) return // landed on the chat page
      if (f.scrollLeft <= last) {
        // Stalled (not advancing): nudge it along, smoothly — never snap.
        this.#placeOnChat('smooth')
      }
      last = f.scrollLeft
      this.#returnTimer = window.setTimeout(poll, SMOOTH_RETRY_MS)
    }
    this.#returnTimer = window.setTimeout(poll, SMOOTH_RETRY_MS)
  }

  /** Install the controller. Safe to call once; a second call is a no-op.
   *  The frame may not exist yet (the layout entry mounts after this
   *  plugin's apply), so the observer chain re-finds it when #root gains
   *  its child. */
  mount(): void {
    if (this.#mounted) return
    this.#mounted = true
    const html = document.documentElement
    this.#html = html
    html.dataset.dshMobile = ''

    this.#installViewportMeta()

    this.#mql = window.matchMedia(MOBILE_BREAKPOINT)
    this.#mql.addEventListener('change', this.#onBreakpointChange)

    // Keyboard inset: the visual viewport shrinks when the OS keyboard
    // opens; the composer seat pads itself by the difference (rAF-throttled
    // — the resize fires every frame of the keyboard animation).
    const vv = window.visualViewport
    vv?.addEventListener('resize', this.#requestKeyboard)
    vv?.addEventListener('scroll', this.#requestKeyboard)

    // Keep the active page in place when the viewport width changes within
    // a breakpoint side (rotation / split-screen reflows the page tracks).
    this.#lastInnerWidth = window.innerWidth
    window.addEventListener('resize', this.#onWindowResize)

    // A tap on the exposed chat card (while the pager rests on the sidebar
    // page) returns to the chat page — PiUI's overlay behavior.
    document.addEventListener('click', this.#onDocClickCapture, true)

    // After a session pick the app auto-focuses the composer textarea; on a
    // phone that pops the OS keyboard over the pager's return-to-chat.
    // Record real pointer-downs (the user's own taps) and, during the
    // post-pick window, blur any focus into the composer that does NOT stem
    // from one — the user's own tap still focuses (they want to type), the
    // automatic focus is bounced.
    document.addEventListener('pointerdown', this.#onPointerDownCapture, true)
    document.addEventListener('focusin', this.#onFocusInCapture, true)
    document.addEventListener('keydown', this.#onComposerKeyDown, true)

    const root = document.getElementById('root')
    if (root !== null) {
      this.#rootObserver = new MutationObserver(() => { this.#ensureFrameObserver() })
      this.#rootObserver.observe(root, { childList: true })
      // The composer mounts/unmounts with the session skeleton and the
      // model name swaps in place: any subtree change can move the label's
      // overflow state, so re-measure on every mutation (rAF-throttled —
      // the check is one querySelector + two reads, cheap even while
      // streaming tokens mutate the tree every frame).
      this.#composerObserver = new MutationObserver(() => { this.#requestMarqueeSync() })
      this.#composerObserver.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }
    // Layout-only overflow changes (row squeeze, font load) do not mutate
    // the tree: watch the label's box too. jsdom has no ResizeObserver, so
    // the guard keeps tests running on the mutation path alone.
    if (typeof ResizeObserver !== 'undefined') {
      this.#marqueeRO = new ResizeObserver(() => { this.#requestMarqueeSync() })
    }
    this.#ensureFrameObserver()
    this.#requestMarqueeSync()

    // The always-open phone layout: expand the sidebar once (AppFrame
    // auto-collapses it to the rail on narrow viewports) so its content
    // stays fully rendered, then start on the CHAT page.
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
    this.#mountFrame = requestAnimationFrame(() => {
      this.#mountFrame = null
      this.#ensureSidebarOpen()
      this.#placeOnChat('auto')
    })
  }

  /** Remove every DOM effect; safe to call twice. */
  dispose(): void {
    if (!this.#mounted || this.#disposed) return
    this.#disposed = true
    this.#mounted = false
    this.#frameObserver?.disconnect()
    this.#frameObserver = null
    this.#rootObserver?.disconnect()
    this.#rootObserver = null
    this.#composerObserver?.disconnect()
    this.#composerObserver = null
    this.#marqueeRO?.disconnect()
    this.#marqueeRO = null
    // Leave the model label as the stock ellipsis render (no marquee trail).
    if (this.#marqueeLabel !== null) {
      const label = this.#marqueeLabel
      label.removeAttribute('data-dshm-marquee')
      label.style.removeProperty('--dshm-marquee-duration')
      const runner = label.firstElementChild
      if (runner !== null && runner.hasAttribute('data-dshm-marquee-runner')) {
        // Unwrap keeping the FIRST item's text (the original nodes — the
        // second item is the seamless-loop clone).
        const original = runner.firstElementChild?.firstChild ?? null
        runner.remove()
        if (original !== null) label.append(original)
      }
    }
    this.#marqueeLabel = null
    this.#mql?.removeEventListener('change', this.#onBreakpointChange)
    this.#mql = null
    window.removeEventListener('resize', this.#onWindowResize)
    window.visualViewport?.removeEventListener('resize', this.#requestKeyboard)
    window.visualViewport?.removeEventListener('scroll', this.#requestKeyboard)
    document.removeEventListener('click', this.#onDocClickCapture, true)
    document.removeEventListener('pointerdown', this.#onPointerDownCapture, true)
    document.removeEventListener('focusin', this.#onFocusInCapture, true)
    document.removeEventListener('keydown', this.#onComposerKeyDown, true)
    for (const timer of [this.#keyboardFrame, this.#mountFrame, this.#resizeTimer, this.#settleTimer, this.#marqueeFrame, this.#returnTimer]) {
      if (timer !== null) (timer === this.#keyboardFrame || timer === this.#mountFrame || timer === this.#marqueeFrame ? cancelAnimationFrame : window.clearTimeout)(timer)
    }
    this.#keyboardFrame = null
    this.#mountFrame = null
    this.#resizeTimer = null
    this.#settleTimer = null
    this.#marqueeFrame = null
    this.#returnTimer = null
    const frame = findFrame()
    if (frame !== null) frame.removeEventListener('scroll', this.#onPagerScroll)
    if (this.#viewportMeta !== null) {
      if (this.#viewportOriginal !== null) this.#viewportMeta.content = this.#viewportOriginal
      else this.#viewportMeta.remove()
      this.#viewportMeta = null
      this.#viewportOriginal = null
    }
    const html = this.#html
    if (html !== null) {
      html.removeAttribute('data-dsh-mobile')
      html.removeAttribute(PAGE_ATTR)
      html.style.removeProperty('--dshm-keyboard-inset')
    }
    this.#html = null
  }

  #installViewportMeta(): void {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (existing !== null) {
      this.#viewportMeta = existing
      this.#viewportOriginal = existing.content
      existing.content = VIEWPORT_CONTENT
      return
    }
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = VIEWPORT_CONTENT
    document.head.append(meta)
    this.#viewportMeta = meta
  }

  /** The always-open phone layout expands the docked sidebar once when the
   *  viewport crosses into the mobile breakpoint (AppFrame auto-collapses
   *  it to the rail there). The request is idempotent: repeated calls while
   *  one expand is still in flight (mount sync pass, rAF pass, late frame)
   *  do not re-toggle. Seeing the frame actually expanded clears the pending
   *  request. A later manual collapse is left alone. */
  readonly #ensureSidebarOpen = (): void => {
    if (!(this.#mql?.matches ?? false)) return
    const frame = findFrame()
    if (frame === null) return
    if (!frame.hasAttribute('data-sidebar-collapsed')) {
      this.#expandPending = false
      return
    }
    if (this.#expandPending) return
    this.#expandPending = true
    this.#options.toggleSidebar()
  }

  /** Scroll the pager to the chat page and mirror the resting page. */
  readonly #placeOnChat = (behavior: ScrollBehavior): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    if (Math.abs(frame.scrollLeft - chatLeft) > 2) {
      frame.scrollTo({ left: chatLeft, behavior })
    }
    this.#mirrorPage(frame, 'chat')
    this.#updateFlipVars(frame)
  }

  /** Mirror the page the pager is resting on (scroll position decides). */
  readonly #mirrorPage = (frame: HTMLElement, hint?: MobilePage): void => {
    const html = this.#html
    if (html === null) return
    const chatLeft = chatPageLeft(frame)
    const page: MobilePage = chatLeft <= 0
      ? (hint ?? 'chat')
      : frame.scrollLeft < chatLeft / 2 ? 'sidebar' : 'chat'
    html.setAttribute(PAGE_ATTR, page)
  }

  /** State flips no longer drive the pager (the page is user-driven); an
   *  expand that landed just clears the pending always-open request. */
  readonly #onFrameCollapseChange = (): void => {
    if (!findFrame()?.hasAttribute('data-sidebar-collapsed')) this.#expandPending = false
  }

  readonly #ensureFrameObserver = (): void => {
    if (this.#frameObserver !== null) return
    const frame = findFrame()
    if (frame === null) return
    this.#frameObserver = new MutationObserver(this.#onFrameCollapseChange)
    this.#frameObserver.observe(frame, {
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed'],
    })
    // Live pager driving (3D flip + settle re-snap) rides the frame's own
    // scroll.
    frame.addEventListener('scroll', this.#onPagerScroll, { passive: true })
    // A frame that appears after mount (the layout entry loads later) still
    // gets the always-open treatment and starts on the chat page.
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
  }

  /** Crossing the breakpoint: entering mobile re-expands the sidebar and
   *  places the pager on the chat page; leaving clears the 3D flip vars so
   *  the desktop layout renders flat. */
  readonly #onBreakpointChange = (): void => {
    const mobile = this.#mql?.matches ?? false
    const frame = findFrame()
    if (!mobile) {
      for (const prop of ['--dshm-rotate', '--dshm-scale', '--dshm-offset-x', '--dshm-origin-x']) {
        frame?.style.removeProperty(prop)
      }
      this.#html?.removeAttribute(PAGE_ATTR)
      return
    }
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
  }

  /** Width reflow within one breakpoint side: keep the active page put and
   *  re-measure the model-name overflow (the row width drives it). Only a
   *  WIDTH change re-anchors — a height-only resize (OS keyboard pop, URL
   *  bar) must never scroll the pager, or it would cancel the smooth
   *  return-to-chat a session pick just started (the composer's focus
   *  landing pops the keyboard exactly then). */
  readonly #onWindowResize = (): void => {
    if (this.#resizeTimer !== null) return
    this.#resizeTimer = window.setTimeout(() => {
      this.#resizeTimer = null
      const frame = findFrame()
      const mobile = this.#mql?.matches ?? false
      if (frame === null || !mobile) return
      const widthChanged = window.innerWidth !== this.#lastInnerWidth
      this.#lastInnerWidth = window.innerWidth
      this.#requestMarqueeSync()
      if (!widthChanged) return
      const chatLeft = chatPageLeft(frame)
      if (chatLeft <= 0) return
      const onChat = frame.scrollLeft >= chatLeft / 2
      frame.scrollTo({ left: onChat ? chatLeft : 0, behavior: 'auto' })
      this.#mirrorPage(frame)
      this.#updateFlipVars(frame)
    }, 120)
  }

  /** Live pager driver: PiUI's 3D flip vars follow the scroll, and once the
   *  scroll settles the pager re-snaps to the nearest whole page (a
   *  short-of-page stop is nudged). The state is deliberately NOT synced —
   *  the sidebar stays expanded (always rendered), so a swipe merely parks
   *  the pager; the sidebar column never re-renders. */
  readonly #onPagerScroll = (): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    this.#updateFlipVars(frame)
    this.#mirrorPage(frame)
    if (this.#settleTimer !== null) window.clearTimeout(this.#settleTimer)
    this.#settleTimer = window.setTimeout(() => {
      this.#settleTimer = null
      this.#settlePager()
    }, SCROLL_SETTLE_MS)
  }

  /** PiUI's flip: progress -1 (sidebar page) … 0 (chat page); the chat card
   *  rotates about the edge toward the swipe side and shrinks, so on the
   *  sidebar page it sinks away leaving only a sliver visible. */
  readonly #updateFlipVars = (frame: HTMLElement): void => {
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    const progress = Math.max(-1, Math.min(1, (frame.scrollLeft - chatLeft) / chatLeft))
    const abs = Math.abs(progress)
    const right = Math.max(0, progress)
    frame.style.setProperty('--dshm-rotate', `${progress * 10}deg`)
    frame.style.setProperty('--dshm-scale', `${1 - abs * 0.06}`)
    frame.style.setProperty('--dshm-offset-x', `${right * right * -48}px`)
    frame.style.setProperty('--dshm-origin-x', `${50 - progress * 50}%`)
  }

  readonly #settlePager = (): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    const left = frame.scrollLeft
    const nearest: MobilePage = left < chatLeft / 2 ? 'sidebar' : 'chat'
    const target = nearest === 'sidebar' ? 0 : chatLeft
    if (Math.abs(left - target) > 4) {
      frame.scrollTo({ left: target, behavior: 'smooth' })
    }
    this.#mirrorPage(frame)
  }

  /** Record every pointerdown (capture, passive) so the focus-in suppressor
   *  can distinguish the user's own tap on the composer from the app's
   *  automatic focus. */
  readonly #onPointerDownCapture = (event: PointerEvent): void => {
    const target = event.target
    this.#lastPointerTarget = target instanceof Element ? target : null
    this.#lastPointerAt = Date.now()
  }

  /** During the post-pick window, bounce automatic focus out of the
   *  composer (the OS keyboard must not cover the return-to-chat). The
   *  user's OWN tap still focuses: a recent pointerdown on the same element
   *  (or inside it) means a real intent to type. */
  readonly #onFocusInCapture = (event: FocusEvent): void => {
    if (Date.now() > this.#focusSuppressUntil) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest('[data-composer-card]') === null) return
    const pointer = this.#lastPointerTarget
    const ownTap = pointer !== null
      && Date.now() - this.#lastPointerAt < POINTER_ALLOW_MS
      && (pointer === target || target.contains(pointer))
    if (ownTap) return
    target.blur()
  }

  /** Touch Enter inserts a newline while preserving the stock modifier and
   *  slash-menu paths. */
  readonly #onComposerKeyDown = (event: KeyboardEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLTextAreaElement) || event.key !== 'Enter') return
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (!this.#mql?.matches || target.closest('[data-composer-card]') === null) return
    if (document.querySelector('[role="listbox"][aria-activedescendant]') !== null) return
    event.stopImmediatePropagation()
  }

  /** A tap on the exposed chat card returns to the chat page (PiUI's
   *  overlay behavior: the exposed chat is not interactive while the
   *  sidebar page is showing). The sidebar's own collapse toggle is
   *  intercepted the same way: collapsing to the rail would unload the
   *  sidebar content, so it flips back to the chat page instead — the
   *  state (expanded) is never touched. */
  readonly #onDocClickCapture = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    const sidebarCol = frame.firstElementChild
    // The sidebar's collapse toggle: stop the rail collapse, return to chat.
    if (sidebarCol instanceof Element && sidebarCol.contains(target)) {
      const btn = target.closest('button')
      if (btn !== null && SIDEBAR_COLLAPSE_LABELS.has(btn.getAttribute('aria-label') ?? '')) {
        event.preventDefault()
        event.stopPropagation()
        this.returnToChat()
        return
      }
    }
    // The exposed chat card: return to chat (only while on the sidebar page).
    if (frame.scrollLeft >= chatLeft / 2) return
    const chatCard = frame.children[1]
    if (chatCard instanceof Element && chatCard.contains(target)) {
      this.returnToChat()
    }
  }

  readonly #requestKeyboard = (): void => {
    if (this.#keyboardFrame !== null) return
    this.#keyboardFrame = requestAnimationFrame(() => {
      this.#keyboardFrame = null
      this.#updateKeyboardInset()
    })
  }

  readonly #updateKeyboardInset = (): void => {
    const html = this.#html
    if (html === null) return
    const vv = window.visualViewport
    const inset = vv !== null && vv.height < window.innerHeight
      ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      : 0
    html.style.setProperty('--dshm-keyboard-inset', `${inset}px`)
  }

  /** Model-name marquee: re-measure on the next frame (mutation streams
   *  can fire every frame while tokens stream). */
  readonly #requestMarqueeSync = (): void => {
    if (this.#marqueeFrame !== null) return
    this.#marqueeFrame = requestAnimationFrame(() => {
      this.#marqueeFrame = null
      this.#syncMarquee()
    })
  }

  /** Measure the model-name label: when the name overflows its capped
   *  width, wrap a DOUBLE copy of the text in a transform layer
   *  (data-dshm-marquee-runner) and tag the label with data-dshm-marquee
   *  + --dshm-marquee-duration — the CSS slides the runner by -50% (one
   *  text width + one MARQUEE_GAP) on the compositor and loops in ONE
   *  direction: the tail exits, a gap passes, then the head re-enters
   *  (classic spaced ticker; no alternate bounce). When the name fits —
   *  or motion is reduced — the runner is unwrapped (original nodes
   *  restored, clone dropped) and the stock ellipsis render returns. The
   *  label is re-resolved every time (the composer remounts with the
   *  session skeleton), and the ResizeObserver is re-hooked when it
   *  changes so pure layout squeezes (row width, font loads) re-trigger
   *  the measure. */
  readonly #syncMarquee = (): void => {
    const label = document.querySelector<HTMLElement>(MODEL_LABEL_SELECTOR)
    if (label !== this.#marqueeLabel) {
      this.#marqueeRO?.disconnect()
      this.#marqueeLabel = label
      if (label !== null) this.#marqueeRO?.observe(label)
    }
    if (label === null) return
    const runner = label.firstElementChild !== null
        && label.firstElementChild.hasAttribute('data-dshm-marquee-runner')
      ? label.firstElementChild
      : null
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const overflow = label.scrollWidth - label.clientWidth
    if (overflow > 0 && !reduceMotion) {
      if (runner === null) {
        // Two item spans, each holding one copy of the text; the CSS gives
        // every item a trailing gap, so -50% = text + gap exactly and the
        // loop is seamless WITH breathing room between repetitions.
        const nodes = Array.from(label.childNodes)
        const layer = document.createElement('span')
        layer.setAttribute('data-dshm-marquee-runner', '')
        for (const node of nodes) {
          const item = document.createElement('span')
          item.setAttribute('data-dshm-marquee-item', '')
          item.append(node)
          layer.append(item)
        }
        for (const node of nodes) {
          const item = document.createElement('span')
          item.setAttribute('data-dshm-marquee-item', '')
          item.append(node.cloneNode(true))
          layer.append(item)
        }
        label.append(layer)
      }
      label.dataset.dshmMarquee = ''
      // After the wrap, scrollWidth = 2 text widths + 2 gaps; one text
      // width + gap at ~50px/s paces the ticker (~200px names -> 5s).
      const textWidth = (label.scrollWidth - MARQUEE_GAP_PX * 2) / 2
      label.style.setProperty('--dshm-marquee-duration', `${Math.max(5, Math.round((textWidth + MARQUEE_GAP_PX) / 50))}s`)
    } else {
      delete label.dataset.dshmMarquee
      label.style.removeProperty('--dshm-marquee-duration')
      if (runner !== null) {
        // Keep the FIRST item's text (the original nodes), drop the rest.
        const original = runner.firstElementChild?.firstChild ?? null
        runner.remove()
        if (original !== null) label.append(original)
      }
    }
  }
}
