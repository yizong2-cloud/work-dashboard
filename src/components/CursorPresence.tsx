import { useEffect, useRef } from 'react'
import cursorSparkle from '../assets/cursor-sparkle.svg'

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  '[role="button"]',
  'summary',
  'select',
  'input[type="checkbox"]',
  'input[type="radio"]',
].join(', ')

const NATIVE_CURSOR_SELECTOR = [
  'textarea',
  'input:not([type="checkbox"]):not([type="radio"])',
  '[contenteditable="true"]',
  'button:disabled',
  'input:disabled',
  'select:disabled',
  '[aria-disabled="true"]',
].join(', ')

/**
 * 桌面端专用的指针陪伴效果。
 * 指针和暖紫雾光均精确跟随；触控设备不加载此体验。
 */
export function CursorPresence() {
  const pointerRef = useRef<HTMLDivElement>(null)
  const auraRef = useRef<HTMLDivElement>(null)
  const burstRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
    if (!finePointer.matches) return

    const pointer = pointerRef.current
    const aura = auraRef.current
    const burst = burstRef.current
    if (!pointer || !aura || !burst) return

    document.documentElement.classList.add('cursor-presence-enabled')

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return

      pointer.style.transform = `translate3d(${event.clientX - 5}px, ${event.clientY - 4}px, 0)`
      aura.style.transform = `translate3d(${event.clientX - 38}px, ${event.clientY - 31}px, 0)`
      pointer.classList.add('is-visible')
      aura.classList.remove('is-hidden')

      const target = event.target instanceof Element ? event.target : null
      const usesNativeCursor = !!target?.closest(NATIVE_CURSOR_SELECTOR)
      aura.classList.toggle('is-native-cursor', usesNativeCursor)
      pointer.classList.toggle('is-native-cursor', usesNativeCursor)
      pointer.classList.toggle('is-interactive', !usesNativeCursor && !!target?.closest(INTERACTIVE_SELECTOR))

    }

    const onPointerDown = (event: PointerEvent) => {
      pointer.classList.add('is-pressing')
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(NATIVE_CURSOR_SELECTOR) || !target?.closest(INTERACTIVE_SELECTOR)) return

      burst.style.transform = `translate3d(${event.clientX - 21}px, ${event.clientY - 21}px, 0)`
      burst.classList.remove('is-active')
      // 强制重启一次性点击墨点动画；不创建额外 DOM，也不会积累节点。
      void burst.offsetWidth
      burst.classList.add('is-active')
    }
    const onPointerUp = () => pointer.classList.remove('is-pressing')
    const hidePointer = () => {
      pointer.classList.remove('is-visible')
      aura.classList.add('is-hidden')
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('blur', hidePointer)
    document.addEventListener('mouseleave', hidePointer)

    return () => {
      document.documentElement.classList.remove('cursor-presence-enabled')
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('blur', hidePointer)
      document.removeEventListener('mouseleave', hidePointer)
    }
  }, [])

  return (
    <div className="cursor-presence" aria-hidden="true">
      <div ref={auraRef} className="cursor-presence-aura" />
      <div ref={burstRef} className="cursor-presence-burst">
        <span>✦</span><span>·</span><span>✧</span>
      </div>
      <div ref={pointerRef} className="cursor-presence-pointer">
        <img src={cursorSparkle} alt="" />
        <span className="cursor-presence-spark cursor-presence-spark-one">✦</span>
        <span className="cursor-presence-spark cursor-presence-spark-two">·</span>
      </div>
    </div>
  )
}
