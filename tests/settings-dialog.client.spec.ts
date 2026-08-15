// @vitest-environment jsdom
/**
 * dsh-mobile settings-dialog contract: the mobile sheet must restructure the
 * stock 800px two-column settings modal into a centered dialog card with a
 * top horizontal tab strip, keeping the dialog affordance (margins, radius),
 * lifting the actions + close buttons onto the title line, and keying every
 * rule off stable role/data-slot hooks scoped under [data-dsh-mobile] so
 * desktop and uninstalled runs stay byte-identical.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(process.cwd(), 'src/client/mobile.css'), 'utf8')

describe('mobile.css settings-dialog contract', () => {
  it('targets the dialog through stable hooks only', () => {
    // The panel is the [role=dialog] element; the nav rail is its <nav>
    // child; the content column is the dialog's last child. No hashed class.
    expect(css).toContain(`[role='dialog']`)
    expect(css).toContain(`[role='dialog']:has(> nav)`)
    expect(css).toContain(`[role='dialog']:has(> nav) > nav`)
    expect(css).toContain(`[role='dialog']:has(> nav) > div:last-child`)
    expect(css).toContain(`[role='dialog']:has(> nav) > div:last-child > div:last-child`)
    expect(css).toContain(`[role='dialog']:has(> nav) > div:last-child > div:first-child`)
  })

  it('keeps the panel a centered dialog card, not a full-screen sheet', () => {
    // The stock modal is a dialog; mobile must keep the affordance — capped
    // width/height with a viewport margin and a rounded radius — while
    // switching to a single column.
    expect(css).toContain(`flex-direction: column`)
    expect(css).toContain(`width: min(560px, calc(100vw - 32px))`)
    expect(css).toContain(`height: min(720px, calc(100vh - 32px))`)
    expect(css).toContain(`border-radius: 20px`)
    // The dialog card itself must not be full-bleed: no zero-radius or
    // viewport-filling width on the [role=dialog] rule body.
    const dialogRule = css.match(/\[role='dialog'\]\s*\{[^}]*\}/)?.[0] ?? ''
    expect(dialogRule).not.toContain(`border-radius: 0`)
    expect(dialogRule).not.toContain(`width: 100%`)
    expect(dialogRule).not.toContain(`height: 100%`)
  })

  it('turns the nav rail into a top horizontal tab strip', () => {
    // The rail loses its fixed 188px width, the cell list flows horizontally
    // and scrolls, and cells become pill tabs.
    expect(css).toContain(`[role='dialog']:has(> nav) > nav > div:nth-child(2)`)
    expect(css).toContain(`flex-direction: row`)
    expect(css).toContain(`overflow-x: auto`)
    expect(css).toContain(`border-radius: 999px`)
    expect(css).toContain(`width: auto`)
  })

  it('lifts the actions + close onto the dialog title line', () => {
    // The content column's header row (actions + close) is absolutely
    // positioned at the card's top-right so it sits on the same line as the
    // nav title (top-left), instead of its own row below the tabs.
    expect(css).toContain(`[role='dialog']:has(> nav) > div:last-child > div:first-child`)
    expect(css).toContain(`position: absolute`)
    expect(css).toContain(`top: 10px`)
    expect(css).toContain(`right: 14px`)
  })

  it('keeps the content column full width and internally scrollable', () => {
    expect(css).toContain(`flex: 1`)
    expect(css).toContain(`min-height: 0`)
    expect(css).toContain(`overflow-y: auto`)
  })

  it('fixes the shared Modal footer box model on mobile', () => {
    // The ui-primitives Modal footer sizes content-box width + 24px side
    // padding, spilling out of the card on phones. The border-box rule is
    // pinned to the dialog's last child whose direct children are buttons,
    // so it cannot hit the settings dialog's content column.
    expect(css).toContain(`[role='dialog'] > :last-child:has(> button)`)
    expect(css).toContain(`box-sizing: border-box`)
    expect(css).toContain(`width: 100%`)
    expect(css).toContain(`min-width: 0`)
  })

  it('keeps the settings fit off every non-nav dialog (Modal, popovers)', () => {
    // The settings panel is the ONLY role=dialog with a <nav> rail; the
    // ui-primitives Modal (permission/RiskConfirmation, agent-preset viewer,
    // delete confirmations) and the context-meter popover are role=dialog
    // without one. The settings width/height/flex rules must be scoped
    // `:has(> nav)` so they never stretch a small confirmation card to
    // full-viewport height.
    const panelRule = css.match(/\[role='dialog'\]\s*\{[^}]*\}/)?.[0] ?? ''
    expect(panelRule).toBe('')
    const scopedPanel = css.match(/\[role='dialog'\]:has\(> nav\)\s*\{[^}]*\}/)?.[0] ?? ''
    expect(scopedPanel).toContain(`height: min(720px, calc(100vh - 32px))`)
    // The content-column flex rule is also scoped (the Modal footer must not
    // become flex:1 and stretch to the bottom).
    expect(css).toContain(`[role='dialog']:has(> nav) > div:last-child`)
    expect(css).not.toContain(`[role='dialog'] > div:last-child {`)
  })

  it('scopes every rule under the mobile attribute', () => {
    // Pull the rule bodies and ensure each starts with a [data-dsh-mobile]
    // scoped selector chain. At-rules (@media/@supports/@keyframes) are
    // skipped — their nested declarations carry their own selectors.
    const bodies = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\n\s*}/)
      .map(part => part.trim())
      .filter(part => part.length > 0)
    for (const body of bodies) {
      const selector = body.split(/\{/)[0]?.trim() ?? ''
      if (selector === '' || /^@(media|supports|keyframes|font-face)/.test(selector)) continue
      expect(selector, `unscoped selector: ${selector}`).toContain(`[data-dsh-mobile]`)
    }
  })
})
