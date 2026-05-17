import { useState, useCallback, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Circle, useMap } from 'react-leaflet'
import { useQuery } from '@tanstack/react-query'
import type { PlaceProfile } from '@/store/config'
import { cn } from '@/lib/utils'

interface GeoCandidate {
  display_name: string
  lat: number
  lng: number
  place_type: string
}

interface Props {
  initial?: PlaceProfile
  onSave: (p: PlaceProfile) => void
  onCancel?: () => void
}

function MapUpdater({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap()
  useEffect(() => {
    map.setView([lat, lng], map.getZoom())
  }, [lat, lng, map])
  return null
}

export default function PlaceEditor({ initial, onSave, onCancel }: Props) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selected, setSelected] = useState<GeoCandidate | null>(
    initial ? { display_name: initial.name, lat: initial.lat, lng: initial.lng, place_type: '' } : null,
  )
  const [name, setName] = useState(initial?.name ?? '')
  const [radius, setRadius] = useState(initial?.radius_km ?? 20)
  const [showDropdown, setShowDropdown] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 400)
    return () => clearTimeout(t)
  }, [query])

  // Close dropdown on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const { data: candidates, isFetching } = useQuery<GeoCandidate[]>({
    queryKey: ['geocode', debouncedQuery],
    queryFn: async () => {
      if (debouncedQuery.length < 2) return []
      const res = await fetch(`/geocode?q=${encodeURIComponent(debouncedQuery)}`)
      if (!res.ok) return []
      return res.json()
    },
    enabled: debouncedQuery.length >= 2,
  })

  const pick = useCallback((c: GeoCandidate) => {
    setSelected(c)
    setName(prev => (prev === '' ? c.display_name.split(',')[0].trim() : prev))
    setQuery(c.display_name)
    setShowDropdown(false)
  }, [])

  const handleSave = () => {
    if (!selected) return
    onSave({ name: name.trim() || selected.display_name, lat: selected.lat, lng: selected.lng, radius_km: radius })
  }

  const defaultPos: [number, number] = selected ? [selected.lat, selected.lng] : [48.8566, 2.3522]

  return (
    <form onSubmit={e => { e.preventDefault(); handleSave() }} className="space-y-4">
      {/* Geocode search */}
      <div className="relative" ref={searchRef}>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Search location</label>
        <input
          className="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          placeholder="City, address, or postal code…"
          value={query}
          onChange={e => { setQuery(e.target.value); setShowDropdown(true) }}
          onFocus={() => setShowDropdown(true)}
          onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
        />
        {isFetching && (
          <span className="absolute right-3 top-9 text-xs text-slate-400 dark:text-slate-500">searching…</span>
        )}
        {showDropdown && candidates && candidates.length > 0 && (
          <ul className="absolute z-50 mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-lg text-sm max-h-52 overflow-auto">
            {candidates.map((c, i) => (
              <li
                key={i}
                className="px-3 py-2 cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/30 border-b border-slate-100 dark:border-slate-700 last:border-0"
                onMouseDown={() => pick(c)}
              >
                <span className="font-medium text-slate-900 dark:text-slate-100">{c.display_name.split(',')[0]}</span>
                <span className="ml-2 text-slate-400 dark:text-slate-500 text-xs">{c.place_type}</span>
                <br />
                <span className="text-slate-400 dark:text-slate-500 text-xs">{c.display_name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Map */}
      <div className="relative z-0 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 h-52">
        <MapContainer center={defaultPos} zoom={12} className="h-full w-full" scrollWheelZoom>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="© OpenStreetMap contributors"
          />
          {selected && (
            <>
              <MapUpdater lat={selected.lat} lng={selected.lng} />
              <Marker position={[selected.lat, selected.lng]} />
              <Circle
                center={[selected.lat, selected.lng]}
                radius={radius * 1000}
                pathOptions={{ color: '#6366f1', fillColor: '#6366f1', fillOpacity: 0.15 }}
              />
            </>
          )}
        </MapContainer>
      </div>

      {/* Radius slider */}
      <div>
        <label className="flex justify-between text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
          <span>Search radius</span>
          <span className="text-indigo-600 dark:text-indigo-400 font-semibold">{radius} km</span>
        </label>
        <input
          type="range" min={1} max={50} step={1}
          value={radius}
          onChange={e => setRadius(Number(e.target.value))}
          className="w-full accent-indigo-600"
        />
      </div>

      {/* Name */}
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Profile name</label>
        <input
          className="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          placeholder="e.g. Paris centre"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={!selected || !name.trim()}
          className={cn(
            'flex-1 rounded-lg py-2 text-sm font-semibold text-white transition-colors',
            selected && name.trim()
              ? 'bg-indigo-600 hover:bg-indigo-700'
              : 'bg-slate-300 dark:bg-slate-600 cursor-not-allowed',
          )}
        >
          Save place
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 rounded-lg py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
