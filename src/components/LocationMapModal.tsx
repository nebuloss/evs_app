import { X } from 'lucide-react'
import { MapContainer, TileLayer, Marker } from 'react-leaflet'
import { useEscapeKey } from '@/hooks/useKeyShortcuts'

interface Props {
  name: string
  lat: number
  lng: number
  onClose: () => void
}

export default function LocationMapModal({ name, lat, lng, onClose }: Props) {
  useEscapeKey(onClose)
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-700">
          <div>
            <p className="font-semibold text-slate-900 dark:text-slate-100">{name}</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{lat.toFixed(5)}, {lng.toFixed(5)}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="relative z-0 h-72">
          <MapContainer
            key={`${lat},${lng}`}
            center={[lat, lng]}
            zoom={15}
            className="h-full w-full"
            zoomControl={true}
            scrollWheelZoom={true}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
            />
            <Marker position={[lat, lng]} />
          </MapContainer>
        </div>
      </div>
    </div>
  )
}
