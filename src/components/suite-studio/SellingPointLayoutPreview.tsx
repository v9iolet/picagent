import { useId, type ReactNode } from "react";
import type { SellingPointLayout } from "../../../shared/selling-point-layouts";

function Copy({ x, y, width, color }: { x: number; y: number; width: number; color: string }) {
  return (
    <g fill={color} transform={`translate(${x} ${y})`}>
      <rect width={width} height="7" rx="2" />
      <rect y="12" width={width * 0.68} height="3" rx="1.5" opacity=".55" />
    </g>
  );
}

function Product({ transform, color }: { transform: string; color: string }) {
  return (
    <g transform={transform}>
      <ellipse cx="43" cy="54" rx="42" ry="6" fill="#0d1520" opacity=".23" />
      <path d="M7 14 21 3h54l10 12v25L72 50H13L7 42Z" fill={color} />
      <path d="M8 15 22 4h53l8 10H22Z" fill="#fff" opacity=".36" />
      <path d="m72 17 12-3v26l-12 9Z" fill="#121824" opacity=".36" />
      <rect x="8" y="14" width="65" height="35" rx="8" fill="#111827" />
      <rect x="12" y="18" width="57" height="26" rx="5" fill={color} opacity=".83" />
      <path d="M18 22h45m-47 4h49m-49 4h49m-49 4h49m-47 4h45" fill="none" stroke="#172033" strokeWidth="1.7" opacity=".62" />
      <circle cx="64" cy="9" r="1.4" fill="#fff" />
      <circle cx="69" cy="9" r="1.4" fill="#fff" opacity=".6" />
    </g>
  );
}

function FeatureIcon({ index, color }: { index: number; color: string }) {
  const paths = ["m-4 1 3 3 6-7", "M0-5v10m-5-5H5", "M-4 3l4-7 4 7Z"];
  return <path d={paths[index]} fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />;
}

const columns = [0, 1, 2];
const layouts: Record<SellingPointLayout["id"], { colors: [string, string]; art: ReactNode }> = {
  hero_color_block: {
    colors: ["#ec6449", "#b92a3f"],
    art: (
      <>
        <path d="M0 74 240 54v78H0Z" fill="#ffbd42" />
        <circle cx="120" cy="68" r="43" fill="#ffdb78" />
        <path d="M51 70h14m110-17 13-7m-16 48 17 5" stroke="#fde5a5" strokeWidth="2" strokeLinecap="round" />
        <Copy x={68} y={17} width={104} color="#fff4d4" />
        <Product transform="translate(68 38) scale(1.18)" color="#253059" />
        <rect x="79" y="109" width="82" height="5" rx="2.5" fill="#67223a" />
      </>
    ),
  },
  macro_callout_lines: {
    colors: ["#1d3945", "#587f8b"],
    art: (
      <>
        <path d="M-10 92 125-19h117v103L124 132H-10Z" fill="#7196a0" />
        <path d="M-9 92 130-14m-122 120L154-14M33 109 181-14M55 115 204-10M76 121 228-7M99 126 249 3M126 129 255 24" fill="none" stroke="#365560" strokeWidth="6" />
        <path d="m-6 94 139-106m-121 120L158-12M37 111 184-11M59 117 207-9M80 123 230-6M103 128 250 6" fill="none" stroke="#9cc1c7" strokeWidth="1.6" opacity=".71" />
        <path d="M84 40 62 29H23m123 33 22-23h45" fill="none" stroke="#fff7db" strokeWidth="1.6" />
        <g fill="#fff7db">
          <circle cx="84" cy="40" r="3" /><circle cx="146" cy="62" r="3" />
          <rect x="23" y="22" width="29" height="3" rx="1.5" /><rect x="180" y="32" width="33" height="3" rx="1.5" />
        </g>
        <path d="M0 89h240v43H0Z" fill="#142732" opacity=".94" />
        <Copy x={18} y={102} width={105} color="#e0f2f1" />
      </>
    ),
  },
  scene_circle_zoom: {
    colors: ["#dce8c7", "#9ab79d"],
    art: (
      <>
        <rect x="95" y="-4" width="55" height="101" rx="23" fill="#edf2d2" opacity=".85" />
        <path d="M108 4v81m29-77v80" stroke="#fff4cc" strokeWidth="3" />
        <path d="M35 88C15 60 36 52 38 78c7-26 26-30 24-4-2 13-13 23-22 32" fill="#60846a" />
        <path d="M0 99 129 80l111 15v37H0Z" fill="#bb8360" />
        <path d="m0 108 155-17m-91 41 176-22" stroke="#d6a17a" strokeWidth="2" />
        <Copy x={17} y={17} width={76} color="#254e49" />
        <Product transform="translate(79 57) rotate(-6)" color="#4f7061" />
        <path d="m142 73 32-21" stroke="#f8f5db" strokeWidth="2" />
        <circle cx="192" cy="45" r="29" fill="#355b52" stroke="#fbf7de" strokeWidth="3" />
        <path d="m176 37 28-10m-31 17 37-13m-38 19 41-14m-38 19 39-14m-35 18 34-12m-30 17 26-10" stroke="#95b5a2" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  },
  ambient_three_icons: {
    colors: ["#1d1f53", "#54459e"],
    art: (
      <>
        <ellipse cx="126" cy="55" rx="75" ry="28" fill="#9b75ef" opacity=".31" />
        <ellipse cx="126" cy="55" rx="48" ry="24" fill="#af8cfa" opacity=".3" />
        <Copy x={73} y={12} width={94} color="#f2e8ff" />
        <Product transform="translate(85 34) rotate(-4) scale(.92)" color="#b696ed" />
        <rect y="88" width="240" height="44" fill="#292653" />
        <path d="M80 94v32m80-32v32" stroke="#665b99" />
        {columns.map((index) => (
          <g key={index} transform={`translate(${40 + index * 80} 104)`}>
            <circle r="9" fill="#4c3c84" stroke="#d1baff" />
            <FeatureIcon index={index} color="#f1e5ff" />
            <rect x="-18" y="15" width="36" height="3" rx="1.5" fill="#bda9ed" />
          </g>
        ))}
      </>
    ),
  },
  top_hero_bottom_trio: {
    colors: ["#f8eee0", "#ddb6a2"],
    art: (
      <>
        <path d="M150-8h79l-34 84H99Z" fill="#fdf1df" opacity=".8" />
        <Copy x={16} y={19} width={90} color="#59433f" />
        <Product transform="translate(121 18) rotate(-6) scale(.94)" color="#b26859" />
        {columns.map((index) => (
          <g key={index} transform={`translate(${index * 80} 79)`}>
            <rect width="79" height="53" fill={["#aa6d60", "#704d50", "#c58b72"][index]} />
            {[
              <path d="M4 31 60 4m-45 28 57-27M26 34 76 10" stroke="#efd1b1" strokeWidth="3" />,
              <><circle cx="39" cy="18" r="13" fill="none" stroke="#efb6a0" strokeWidth="3" /><circle cx="39" cy="18" r="5" fill="#efb6a0" /></>,
              <path d="M12 27h56M18 21h44M24 15h32M29 9h22" stroke="#f5ceaa" strokeWidth="3" />,
            ][index]}
            <rect y="36" width="79" height="17" fill="#24212a" />
            <rect x="23" y="43" width="33" height="3" rx="1.5" fill="#f5e0cf" />
          </g>
        ))}
        <path d="M0 78h240m-160 0v54m80-54v54" stroke="#f8ede4" strokeWidth="2" />
      </>
    ),
  },
  left_pills_right_hero: {
    colors: ["#142440", "#2f66ae"],
    art: (
      <>
        <path d="M151 0h89v132H97Z" fill="#4e91dd" opacity=".54" />
        <path d="M211 0h22l-93 132h-17Z" fill="#abd8ff" opacity=".31" />
        <Copy x={16} y={16} width={88} color="#eff9ff" />
        {columns.map((index) => (
          <g key={index} transform={`translate(16 ${47 + 22 * index})`}>
            <rect width="76" height="16" rx="8" fill="#daeeff" />
            <g transform="translate(10 8) scale(.75)"><FeatureIcon index={index} color="#28578f" /></g>
            <rect x="22" y="6" width="42" height="4" rx="2" fill="#5078a1" />
          </g>
        ))}
        <Product transform="translate(107 54) rotate(-18) scale(1.37)" color="#62b6eb" />
      </>
    ),
  },
  hero_zoom_spec_box: {
    colors: ["#f6e9cc", "#d9c49d"],
    art: (
      <>
        <Copy x={19} y={15} width={103} color="#453d32" />
        <path d="M0 110h124v22H0Z" fill="#b8a383" />
        <Product transform="translate(17 52) scale(1.25)" color="#9a8251" />
        <rect x="62" y="70" width="33" height="24" rx="2" fill="none" stroke="#f8de82" strokeWidth="2" strokeDasharray="4 2" />
        <path d="m95 81 43-24" stroke="#6f5942" strokeWidth="1.5" />
        <rect x="138" y="38" width="84" height="81" rx="5" fill="#f7efde" stroke="#8e7556" strokeWidth="1.4" />
        <rect x="144" y="44" width="72" height="46" rx="3" fill="#79684d" />
        <path d="m151 79 43-28m-37 32 47-31m-39 33 44-29m-31 29 31-20" stroke="#c7ad77" strokeWidth="3" strokeLinecap="round" />
        <Copy x={147} y={96} width={50} color="#674f37" />
      </>
    ),
  },
  top_cards_bottom_hero: {
    colors: ["#e4d7ef", "#8c77bd"],
    art: (
      <>
        <path d="M0 109 120 84l120 25v23H0Z" fill="#695397" />
        <path d="M37 132 127 89m83 43-72-43" stroke="#cdbbf4" strokeWidth="1.4" opacity=".65" />
        {columns.map((index) => (
          <g key={index} transform={`translate(${13 + 73 * index} 10)`}>
            <rect width="68" height="34" rx="7" fill="#fcf4ff" />
            <circle cx="13" cy="14" r="8" fill="#e4d5f2" />
            <g transform="translate(13 14) scale(.8)"><FeatureIcon index={index} color="#645285" /></g>
            <rect x="26" y="9" width="32" height="4" rx="2" fill="#745f98" />
            <rect x="26" y="17" width="23" height="3" rx="1.5" fill="#b09acb" />
          </g>
        ))}
        <Product transform="translate(64 55) skewY(-5) scale(1.42 1.22)" color="#c6aff2" />
        <path d="m75 105 83-7 25-13" stroke="#e9d7ff" strokeWidth="1.5" opacity=".64" />
      </>
    ),
  },
  split_scene_closeup: {
    colors: ["#d6b696", "#b18267"],
    art: (
      <>
        <rect x="119" width="121" height="132" fill="#3d534f" />
        <rect x="12" y="25" width="50" height="66" rx="18" fill="#f4d5ad" />
        <path d="M0 105 92 91l27 9v32H0Z" fill="#7e624d" />
        <path d="M57 105c-3-21-7-49 11-52 16-3 25 11 25 39l-9 21Z" fill="#426358" />
        <circle cx="71" cy="41" r="12" fill="#c67d61" />
        <path d="M58 40c-8-14 12-23 23-14l4 11c-11 0-13-3-18-4l-6 11Z" fill="#483c37" />
        <path d="m79 72 14 17 12-9" fill="none" stroke="#c67d61" strokeWidth="7" strokeLinecap="round" />
        <Product transform="translate(82 70) scale(.42)" color="#a6a075" />
        <Product transform="translate(114 35) rotate(-9) scale(1.9 1.44)" color="#a6a075" />
        <path d="M119 0v132" stroke="#f0ddbe" strokeWidth="2" />
        <rect x="8" y="112" width="58" height="13" rx="3" fill="#402f29" opacity=".78" />
        <rect x="128" y="112" width="70" height="13" rx="3" fill="#203b35" opacity=".84" />
        <path d="M16 118h42m78 0h53" stroke="#f5e6cb" strokeWidth="3" strokeLinecap="round" />
      </>
    ),
  },
};

export function SellingPointLayoutPreview({ id }: { id: SellingPointLayout["id"] }) {
  const gradientId = useId();
  const { colors, art } = layouts[id];
  return (
    <svg viewBox="0 0 240 132" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x2="1" y2="1">
          <stop stopColor={colors[0]} />
          <stop offset="1" stopColor={colors[1]} />
        </linearGradient>
      </defs>
      <rect width="240" height="132" fill={`url(#${gradientId})`} />
      {art}
    </svg>
  );
}
