import { useRef, useMemo, useState, useEffect, type CSSProperties, type MutableRefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'

type ImageItem = string | { src: string; alt?: string }

interface FadeSettings {
	fadeIn: { start: number; end: number }
	fadeOut: { start: number; end: number }
}

interface BlurSettings {
	blurIn: { start: number; end: number }
	blurOut: { start: number; end: number }
	maxBlur: number
}

interface InfiniteGalleryProps {
	images: ImageItem[]
	/** Distance along the flythrough axis between consecutive images. */
	zSpacing?: number
	/** How gradually (in track units) each image fades/blurs in and out. */
	fadeWindow?: number
	fadeSettings?: FadeSettings
	blurSettings?: BlurSettings
	/** 0 = start of the wall, 1 = end — driven by the caller's scroll progress. Read every frame, no re-render needed. */
	progressRef: MutableRefObject<number>
	className?: string
	style?: CSSProperties
}

const MAX_HORIZONTAL_OFFSET = 3
const MAX_VERTICAL_OFFSET = 2

const createClothMaterial = () => {
	return new THREE.ShaderMaterial({
		transparent: true,
		uniforms: {
			map: { value: null },
			opacity: { value: 1.0 },
			blurAmount: { value: 0.0 },
			scrollForce: { value: 0.0 },
			time: { value: 0.0 },
			isHovered: { value: 0.0 },
		},
		vertexShader: `
      uniform float scrollForce;
      uniform float time;
      uniform float isHovered;
      varying vec2 vUv;
      varying vec3 vNormal;

      void main() {
        vUv = uv;
        vNormal = normal;

        vec3 pos = position;

        // Create smooth curving based on scroll force
        float curveIntensity = scrollForce * 0.3;

        // Base curve across the plane based on distance from center
        float distanceFromCenter = length(pos.xy);
        float curve = distanceFromCenter * distanceFromCenter * curveIntensity;

        // Add gentle cloth-like ripples
        float ripple1 = sin(pos.x * 2.0 + scrollForce * 3.0) * 0.02;
        float ripple2 = sin(pos.y * 2.5 + scrollForce * 2.0) * 0.015;
        float clothEffect = (ripple1 + ripple2) * abs(curveIntensity) * 2.0;

        // Flag waving effect when hovered
        float flagWave = 0.0;
        if (isHovered > 0.5) {
          float wavePhase = pos.x * 3.0 + time * 8.0;
          float waveAmplitude = sin(wavePhase) * 0.1;
          float dampening = smoothstep(-0.5, 0.5, pos.x);
          flagWave = waveAmplitude * dampening;

          float secondaryWave = sin(pos.x * 5.0 + time * 12.0) * 0.03 * dampening;
          flagWave += secondaryWave;
        }

        pos.z -= (curve + clothEffect + flagWave);

        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
		fragmentShader: `
      uniform sampler2D map;
      uniform float opacity;
      uniform float blurAmount;
      uniform float scrollForce;
      varying vec2 vUv;
      varying vec3 vNormal;

      void main() {
        vec4 color = texture2D(map, vUv);

        if (blurAmount > 0.0) {
          vec2 texelSize = 1.0 / vec2(textureSize(map, 0));
          vec4 blurred = vec4(0.0);
          float total = 0.0;

          for (float x = -2.0; x <= 2.0; x += 1.0) {
            for (float y = -2.0; y <= 2.0; y += 1.0) {
              vec2 offset = vec2(x, y) * texelSize * blurAmount;
              float weight = 1.0 / (1.0 + length(vec2(x, y)));
              blurred += texture2D(map, vUv + offset) * weight;
              total += weight;
            }
          }
          color = blurred / total;
        }

        float curveHighlight = abs(scrollForce) * 0.05;
        color.rgb += vec3(curveHighlight * 0.1);

        gl_FragColor = vec4(color.rgb, color.a * opacity);
      }
    `,
	})
}

/** Fade/blur curve shared by opacity and blur — a value that ramps 0→1 across
 *  [inStart, inEnd], holds, then ramps back across [outStart, outEnd]. */
function fadeCurve(phase: number, start: { start: number; end: number }, end: { start: number; end: number }) {
	if (phase < start.start) return 0
	if (phase <= start.end) return (phase - start.start) / (start.end - start.start)
	if (phase < end.start) return 1
	if (phase <= end.end) return 1 - (phase - end.start) / (end.end - end.start)
	return 0
}

function GalleryScene({
	images,
	zSpacing = 7,
	fadeWindow,
	progressRef,
	fadeSettings = {
		fadeIn: { start: 0.0, end: 0.15 },
		fadeOut: { start: 0.85, end: 1.0 },
	},
	blurSettings = {
		blurIn: { start: 0.0, end: 0.12 },
		blurOut: { start: 0.88, end: 1.0 },
		maxBlur: 3.0,
	},
}: Omit<InfiniteGalleryProps, 'className' | 'style'>) {
	const normalizedImages = useMemo(
		() => images.map((img) => (typeof img === 'string' ? { src: img, alt: '' } : img)),
		[images],
	)
	const count = normalizedImages.length
	const window_ = fadeWindow ?? zSpacing * 1.3

	const textures = useTexture(normalizedImages.map((img) => img.src))

	const materials = useMemo(
		() =>
			normalizedImages.map((_, i) => {
				const material = createClothMaterial()
				material.uniforms.map.value = textures[i]
				return material
			}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[normalizedImages, textures],
	)

	const spatialPositions = useMemo(() => {
		const positions: { x: number; y: number }[] = []
		for (let i = 0; i < count; i++) {
			const horizontalAngle = (i * 2.618) % (Math.PI * 2)
			const verticalAngle = (i * 1.618 + Math.PI / 3) % (Math.PI * 2)
			const horizontalRadius = (i % 3) * 0.6
			const verticalRadius = ((i + 1) % 4) * 0.4
			positions.push({
				x: (Math.sin(horizontalAngle) * horizontalRadius * MAX_HORIZONTAL_OFFSET) / 3,
				y: (Math.cos(verticalAngle) * verticalRadius * MAX_VERTICAL_OFFSET) / 4,
			})
		}
		return positions
	}, [count])

	const scales = useMemo<[number, number, number][]>(
		() =>
			normalizedImages.map((_, i) => {
				const tex = textures[i]
				const image = tex?.image as { width?: number; height?: number } | undefined
				const aspect = image?.width && image?.height ? image.width / image.height : 1
				return aspect > 1 ? [2 * aspect, 2, 1] : [2, 2 / aspect, 1]
			}),
		[normalizedImages, textures],
	)

	const meshRefs = useRef<(THREE.Mesh | null)[]>([])
	const prevCameraPos = useRef(-window_)
	const smoothedVelocity = useRef(0)
	const totalTrackLength = Math.max((count - 1) * zSpacing + 2 * window_, 1)

	useFrame((state) => {
		const progress = Math.min(Math.max(progressRef.current, 0), 1)
		const cameraTrackPosition = -window_ + progress * totalTrackLength
		const rawVelocity = cameraTrackPosition - prevCameraPos.current
		prevCameraPos.current = cameraTrackPosition
		// Ease toward the latest velocity so a fast flick's cloth-curve ripples
		// in smoothly instead of snapping to the raw frame-to-frame delta.
		smoothedVelocity.current += (rawVelocity - smoothedVelocity.current) * 0.08
		const velocity = Math.max(-1.0, Math.min(1.0, smoothedVelocity.current))
		const time = state.clock.getElapsedTime()

		for (let i = 0; i < count; i++) {
			const material = materials[i]
			const mesh = meshRefs.current[i]
			if (!material || !mesh) continue

			const trackPosition = i * zSpacing
			const localPhase = Math.min(
				Math.max((cameraTrackPosition - trackPosition + window_) / (2 * window_), 0),
				1,
			)

			const opacity = fadeCurve(localPhase, fadeSettings.fadeIn, fadeSettings.fadeOut)
			const blurPhase = fadeCurve(localPhase, blurSettings.blurIn, blurSettings.blurOut)
			const blur = blurSettings.maxBlur * (1 - blurPhase)

			material.uniforms.time.value = time
			material.uniforms.scrollForce.value = velocity
			material.uniforms.opacity.value = opacity
			material.uniforms.blurAmount.value = blur

			const pos = spatialPositions[i]
			mesh.position.set(pos?.x ?? 0, pos?.y ?? 0, cameraTrackPosition - trackPosition)
			mesh.visible = opacity > 0.001
		}
	})

	if (count === 0) return null

	return (
		<>
			{normalizedImages.map((img, i) => {
				const material = materials[i]
				if (!material) return null
				return (
					<mesh
						key={img.src}
						ref={(el) => {
							meshRefs.current[i] = el
						}}
						scale={scales[i] ?? [2, 2, 1]}
						material={material}
						onPointerEnter={() => {
							material.uniforms.isHovered.value = 1.0
						}}
						onPointerLeave={() => {
							material.uniforms.isHovered.value = 0.0
						}}
					>
						<planeGeometry args={[1, 1, 32, 32]} />
					</mesh>
				)
			})}
		</>
	)
}

/** Widen the FOV on narrow/portrait viewports so the flythrough images are not
 *  cropped by the reduced horizontal field of view. */
function ResponsiveCamera() {
	const camera = useThree((state) => state.camera)
	const size = useThree((state) => state.size)

	useEffect(() => {
		if (!(camera instanceof THREE.PerspectiveCamera)) return
		const aspect = size.width / Math.max(size.height, 1)
		const fov = aspect < 0.75 ? 78 : aspect < 1 ? 68 : 55
		if (camera.fov !== fov) {
			camera.fov = fov
			camera.updateProjectionMatrix()
		}
	}, [camera, size])

	return null
}

// Fallback component for when WebGL is not available
function FallbackGallery({ images }: { images: ImageItem[] }) {
	const normalizedImages = useMemo(
		() => images.map((img) => (typeof img === 'string' ? { src: img, alt: '' } : img)),
		[images],
	)

	return (
		<div className="flex h-full flex-col items-center justify-center p-4">
			<p className="mb-4 text-ink/60">WebGL not supported. Showing image list:</p>
			<div className="grid max-h-96 grid-cols-2 gap-4 overflow-y-auto md:grid-cols-3">
				{normalizedImages.map((img, i) => (
					<img key={i} src={img.src || '/placeholder.svg'} alt={img.alt} className="h-32 w-full rounded object-cover" />
				))}
			</div>
		</div>
	)
}

export default function InfiniteGallery({
	images,
	className = 'h-96 w-full',
	style,
	zSpacing,
	fadeWindow,
	fadeSettings,
	blurSettings,
	progressRef,
}: InfiniteGalleryProps) {
	const [webglSupported, setWebglSupported] = useState(true)
	const containerRef = useRef<HTMLDivElement | null>(null)
	const [inView, setInView] = useState(true)

	/* Rendering while the gallery is far off-screen burns GPU/CPU for frames
	 * nobody sees; pause the frameloop out of view and resume just before the
	 * section scrolls back in. */
	useEffect(() => {
		const el = containerRef.current
		if (!el || typeof IntersectionObserver === 'undefined') return
		const observer = new IntersectionObserver(
			(entries) => setInView(Boolean(entries[0]?.isIntersecting)),
			{ rootMargin: '30% 0px' },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	// Nudge the container measurement once after mount — the initial
	// ResizeObserver tick can be missed, leaving the canvas at 300x150.
	useEffect(() => {
		const id = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 150)
		return () => window.clearTimeout(id)
	}, [])

	useEffect(() => {
		try {
			const canvas = document.createElement('canvas')
			const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
			if (!gl) setWebglSupported(false)
		} catch {
			setWebglSupported(false)
		}
	}, [])

	if (!webglSupported) {
		return (
			<div className={className} style={style}>
				<FallbackGallery images={images} />
			</div>
		)
	}

	return (
		<div ref={containerRef} className={className} style={style}>
			<Canvas
				camera={{ position: [0, 0, 0], fov: 55 }}
				dpr={[1, 2]}
				frameloop={inView ? 'always' : 'never'}
				gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
			>
				<ResponsiveCamera />
				<GalleryScene
					images={images}
					zSpacing={zSpacing}
					fadeWindow={fadeWindow}
					fadeSettings={fadeSettings}
					blurSettings={blurSettings}
					progressRef={progressRef}
				/>
			</Canvas>
		</div>
	)
}
