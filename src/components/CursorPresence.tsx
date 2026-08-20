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
 * 指针本体精确跟随，光晕以轻微惯性追随；触控设备和减少动态偏好自动停用。
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

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let targetX = -100
    let targetY = -100
    let auraX = -100
    let auraY = -100
    let frameId = 0

    document.documentElement.classList.add('cursor-presence-enabled')

    const paintAura = () => {
      aura.style.transform = `translate3d(${auraX - 38}px, ${auraY - 31}px, 0)`
    }

    const animateAura = () => {
      auraX += (targetX - auraX) * 0.18
      auraY += (targetY - auraY) * 0.18
      paintAura()
      frameId = window.requestAnimationFrame(animateAura)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return

      targetX = event.clientX
      targetY = event.clientY
      pointer.style.transform = `translate3d(${targetX - 5}px, ${targetY - 4}px, 0)`
      pointer.classList.add('is-visible')
      aura.classList.remove('is-hidden')

      const target = event.target instanceof Element ? event.target : null
      const usesNativeCursor = !!target?.closest(NATIVE_CURSOR_SELECTOR)
      aura.classList.toggle('is-native-cursor', usesNativeCursor)
      pointer.classList.toggle('is-native-cursor', usesNativeCursor)
      pointer.classList.toggle('is-interactive', !usesNativeCursor && !!target?.closest(INTERACTIVE_SELECTOR))

      if (reduceMotion) {
        auraX = targetX
        auraY = targetY
        paintAura()
      }
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

    if (!reduceMotion) frameId = window.requestAnimationFrame(animateAura)

    return () => {
      document.documentElement.classList.remove('cursor-presence-enabled')
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('blur', hidePointer)
      document.removeEventListener('mouseleave', hidePointer)
      if (frameId) window.cancelAnimationFrame(frameId)
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
