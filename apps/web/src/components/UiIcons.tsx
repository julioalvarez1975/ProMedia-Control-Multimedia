/** Shared SVG glyphs for Guion toolbar + preview transport (no emoji).
 * Guion toolbar icons follow Bootstrap Icons shapes (16×16, filled). */

type IconProps = {
  className?: string;
  size?: number;
};

function svgProps({ className, size = 18 }: IconProps) {
  return {
    className: className ?? "ui-icon-svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    "aria-hidden": true as const,
  };
}

/** Bootstrap Icons–style 16×16 filled glyph. */
function biProps({ className, size = 16 }: IconProps) {
  return {
    className: className ?? "ui-icon-svg",
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "currentColor",
    "aria-hidden": true as const,
  };
}

/** Link / YouTube URL (bi-youtube). */
export function IconYoutube(props: IconProps) {
  return (
    <svg {...biProps(props)}>
      <path d="M8.051 1.999h.089c.822.003 4.987.033 6.11.335a2.01 2.01 0 0 1 1.415 1.42c.10.20.0.5.336 2.54v3.413s-.003 1.732-.335 2.54a2.01 2.01 0 0 1-1.416 1.42c-1.123.302-5.288.332-6.11.335h-.088c-.822-.003-4.987-.033-6.11-.335a2.01 2.01 0 0 1-1.415-1.42C.29 10.987.288 9.913.287 9.913V6.5s.002-1.732.335-2.54A2.01 2.01 0 0 1 2.038 2.334C3.16 2.032 7.326 2.002 8.15 2zM8 5.807 5 7.706v.844l3 1.9 3-1.9v-.844z" />
    </svg>
  );
}

/** Bible / book (bi-book). */
export function IconBible(props: IconProps) {
  return (
    <svg {...biProps(props)}>
      <path d="M1 2.828c.885-.37 2.154-.769 3.388-.893C5.949 1.795 7.385 2 8 2s2.051-.205 3.612-.065c1.234.124 2.503.523 3.388.893v9.823c-.885.37-2.154.769-3.388.893C10.051 13.795 8.615 14 8 14s-2.051.205-3.612.065c-1.234-.124-2.503-.523-3.388-.893zm1.5.795v8.206c.826.3 1.903.596 3.053.702C7.054 12.687 7.672 12.75 8 12.75s.946-.063 2.447-.219c1.15-.106 2.227-.402 3.053-.702V3.623c-.826.3-1.903.596-3.053.702C8.946 4.563 8.328 4.625 8 4.625s-.946.063-2.447.219c-1.15.106-2.227.402-3.053.702" />
    </svg>
  );
}

/** Blank text slide (capital T — clear “texto” affordance). */
export function IconType(props: IconProps) {
  return (
    <svg {...biProps(props)}>
      <path d="M2.5 3a.5.5 0 0 0 0 1h4.75v9.5a.5.5 0 0 0 1 0V4H13a.5.5 0 0 0 0-1z" />
    </svg>
  );
}

/** Create song / music (bi-music-note-beamed). */
export function IconMusicNote(props: IconProps) {
  return (
    <svg {...biProps(props)}>
      <path d="M6 13c0 1.105-1.12 2-2.5 2S1 14.105 1 13s1.12-2 2.5-2 2.5.895 2.5 2m9-2c0 1.105-1.12 2-2.5 2s-2.5-.895-2.5-2 1.12-2 2.5-2 2.5.895 2.5 2" />
      <path fillRule="evenodd" d="M14 11V2h1v9zM6 3v10H5V3z" />
      <path d="M5 2.905a1 1 0 0 1 .9-.995l8-.8a1 1 0 0 1 1.1.995V3L5 4z" />
    </svg>
  );
}

/** Audio file / mic (bi-headphones). */
export function IconHeadphones(props: IconProps) {
  return (
    <svg {...biProps(props)}>
      <path d="M8 3a5 5 0 0 0-5 5v1h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a6 6 0 1 1 12 0v5a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1V8a5 5 0 0 0-5-5" />
    </svg>
  );
}

/** Biblioteca (bi-collection). */
export function IconLibrary(props: IconProps) {
  return (
    <svg {...biProps(props)}>
      <path d="M2.5 3.5a.5.5 0 0 1 0-1h11a.5.5 0 0 1 0 1zm2-2a.5.5 0 0 1 0-1h7a.5.5 0 0 1 0 1zM0 13a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 16 13V6a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 0 6zm1.5.5A.5.5 0 0 1 1 13V6a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5z" />
    </svg>
  );
}

/** Primary «Añadir»: file + plus — opens multi-file picker (bi-file-earmark-plus). */
export function IconAddFiles(props: IconProps) {
  return (
    <svg {...biProps(props)}>
      <path d="M8 6.5a.5.5 0 0 1 .5.5v1.5H10a.5.5 0 0 1 0 1H8.5V11a.5.5 0 0 1-1 0V9.5H6a.5.5 0 0 1 0-1h1.5V7a.5.5 0 0 1 .5-.5" />
      <path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5z" />
    </svg>
  );
}

/** Open / load guion file (bi-folder2-open). */
export function IconFolderOpen(props: IconProps) {
  return (
    <svg {...biProps(props)}>
      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.84.49 2.37 1.304L8.18 4H13.5A1.5 1.5 0 0 1 15 5.5v1a.5.5 0 0 1-1 0v-1a.5.5 0 0 0-.5-.5H7.94c-.34 0-.664-.16-.873-.436L6.236 3.304A.5.5 0 0 0 5.764 3H2.5a.5.5 0 0 0-.5.5V13a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V9.5a.5.5 0 0 1 1 0V13a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 1 13z" />
      <path d="M15.854 7.146a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708 0l-1.5-1.5a.5.5 0 1 1 .708-.708L12.5 9.793l2.646-2.647a.5.5 0 0 1 .708 0" />
    </svg>
  );
}

/** Save guion to disk (bi-floppy). */
export function IconSave(props: IconProps) {
  return (
    <svg {...biProps(props)}>
      <path d="M11 2H9v3h2z" />
      <path d="M1.5 0h11.586a1.5 1.5 0 0 1 1.06.44l1.415 1.414A1.5 1.5 0 0 1 16 2.914V14.5A1.5 1.5 0 0 1 14.5 16h-13A1.5 1.5 0 0 1 0 14.5v-13A1.5 1.5 0 0 1 1.5 0M1 1.5v13a.5.5 0 0 0 .5.5H2v-4.5A1.5 1.5 0 0 1 3.5 9h9a1.5 1.5 0 0 1 1.5 1.5V15h.5a.5.5 0 0 0 .5-.5V2.914a.5.5 0 0 0-.146-.353l-1.415-1.415A.5.5 0 0 0 13.086 1H13v4.5A1.5 1.5 0 0 1 11.5 7h-7A1.5 1.5 0 0 1 3 5.5V1H1.5a.5.5 0 0 0-.5.5m3 4a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V1H4zM3 15h10v-4.5a.5.5 0 0 0-.5-.5h-9a.5.5 0 0 0-.5.5z" />
    </svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 5.5v13l11-6.5L8 5.5Z" fill="currentColor" />
    </svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

export function IconSkipBack(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M11 12 18 6.5v11L11 12Z" fill="currentColor" />
      <path d="M6 12 13 6.5v11L6 12Z" fill="currentColor" />
      <rect x="4" y="6" width="2.2" height="12" rx="0.6" fill="currentColor" />
    </svg>
  );
}

export function IconSkipForward(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M13 12 6 6.5v11L13 12Z" fill="currentColor" />
      <path d="M18 12 11 6.5v11L18 12Z" fill="currentColor" />
      <rect x="17.8" y="6" width="2.2" height="12" rx="0.6" fill="currentColor" />
    </svg>
  );
}

export function IconVolumeOn(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path
        d="M4 9.5h3.2L12 6v12l-4.8-3.5H4V9.5Z"
        fill="currentColor"
      />
      <path
        d="M15.2 9.2a3.2 3.2 0 0 1 0 5.6M17.5 7a6 6 0 0 1 0 10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconVolumeOff(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path
        d="M4 9.5h3.2L12 6v12l-4.8-3.5H4V9.5Z"
        fill="currentColor"
      />
      <path
        d="m15 9.5 5 5M20 9.5l-5 5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconPrev(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 16 })}>
      <path
        d="M15 5 8 12l7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconNext(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 16 })}>
      <path
        d="m9 5 7 7-7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Send selected item live (Go Live). */
export function IconGoLive(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 16 })}>
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
      <path
        d="M7.2 7.2a6.8 6.8 0 0 1 9.6 0M5 5a9.5 9.5 0 0 1 14 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Soft tip / status — circle with “i”. */
export function IconInfo(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 16 })}>
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M12 10.5V17M12 7.2h.01"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Warning tip — triangle with “!”. */
export function IconWarn(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 16 })}>
      <path
        d="M12 3.5 21 19.5H3L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M12 9.5v5M12 16.8h.01"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Project / cast to output. */
export function IconProject(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 20 })}>
      <rect
        x="3"
        y="4"
        width="18"
        height="12"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M8 20h8M12 16v4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Settings gear — drawn here, not loaded from an icon package. */
export function IconGear(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 20 })}>
      <circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M19.1 4.9l-1.6 1.6M6.5 17.5l-1.6 1.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Language / locale. */
export function IconLanguage(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 20 })}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M3.5 12h17M12 3c2.5 2.8 3.8 5.8 3.8 9s-1.3 6.2-3.8 9c-2.5-2.8-3.8-5.8-3.8-9s1.3-6.2 3.8-9Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Transition effects (bi-magic). */
export function IconEffects(props: IconProps) {
  return (
    <svg {...biProps({ ...props, size: props.size ?? 16 })}>
      <path d="M9.5 2.672a.5.5 0 1 0 1 0V.843a.5.5 0 0 0-1 0zm4.354.344a.5.5 0 0 0-.707-.707l-.646.647a.5.5 0 0 0 .708.707zM7.293.707A.5.5 0 0 0 6.586 0H1.5A1.5 1.5 0 0 0 0 1.5v13A1.5 1.5 0 0 0 1.5 16h13a1.5 1.5 0 0 0 1.5-1.5V9.414a.5.5 0 0 0-.707-.707L13 10.293V14.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5h3.793z" />
      <path d="M8.5 5.5a.5.5 0 0 0-1 0v.634l-.549-.317a.5.5 0 1 0-.5.866L7 7l-.549.317a.5.5 0 1 0 .5.866l.549-.317V8.5a.5.5 0 1 0 1 0v-.634l.549.317a.5.5 0 1 0 .5-.866L9 7l.549-.317a.5.5 0 1 0-.5-.866l-.549.317zM5.5 9.5a.5.5 0 0 0-1 0v.634l-.549-.317a.5.5 0 1 0-.5.866L4 11l-.549.317a.5.5 0 1 0 .5.866l.549-.317V12.5a.5.5 0 1 0 1 0v-.634l.549.317a.5.5 0 1 0 .5-.866L6 11l.549-.317a.5.5 0 1 0-.5-.866l-.549.317zm5 0a.5.5 0 0 0-1 0v.634l-.549-.317a.5.5 0 1 0-.5.866L9 11l-.549.317a.5.5 0 1 0 .5.866l.549-.317V12.5a.5.5 0 1 0 1 0v-.634l.549.317a.5.5 0 1 0 .5-.866L11 11l.549-.317a.5.5 0 1 0-.5-.866l-.549.317z" />
    </svg>
  );
}

/** Stage background (bi-image). */
export function IconBackground(props: IconProps) {
  return (
    <svg {...biProps({ ...props, size: props.size ?? 16 })}>
      <path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0" />
      <path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1z" />
    </svg>
  );
}

export function IconAbout(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 20 })}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 10.5V17M12 7.2h.01"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconSubtitles(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 20 })}>
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
      />
      <path
        d="M6 14.5h7M6 11h12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Scene: permanent venue logo. */
export function IconSceneLogo(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 18 })}>
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="11" r="3.2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8.5 16.5c.9-1.4 2.1-2.1 3.5-2.1s2.6.7 3.5 2.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Upload / replace the permanent logo image. */
export function IconUploadLogo(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 16 })}>
      <path
        d="M12 15V4m0 0L8 8m4-4 4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Corner watermark mark. */
export function IconWatermark(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 18 })}>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <rect
        x="13.5"
        y="5.5"
        width="6"
        height="4.5"
        rx="0.8"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

/** Dot pattern darkening overlay. */
export function IconDotsOverlay(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 18 })}>
      <circle cx="7" cy="7" r="1.35" fill="currentColor" />
      <circle cx="12" cy="7" r="1.35" fill="currentColor" />
      <circle cx="17" cy="7" r="1.35" fill="currentColor" />
      <circle cx="7" cy="12" r="1.35" fill="currentColor" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" />
      <circle cx="17" cy="12" r="1.35" fill="currentColor" />
      <circle cx="7" cy="17" r="1.35" fill="currentColor" />
      <circle cx="12" cy="17" r="1.35" fill="currentColor" />
      <circle cx="17" cy="17" r="1.35" fill="currentColor" />
    </svg>
  );
}

/** Empty / black scene. */
export function IconVideoCover(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 18 })}>
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="8.5" cy="10" r="1.6" fill="currentColor" />
      <path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

export function IconSceneEmpty(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 18 })}>
      <rect
        x="4"
        y="5"
        width="16"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="currentColor"
        fillOpacity="0.22"
      />
    </svg>
  );
}



/** Save lyrics to the Biblioteca. */
export function IconSaveLyrics(props: IconProps) {
  return (
    <svg {...svgProps({ ...props, size: props.size ?? 20 })}>
      <path
        d="M12 4v10m0 0-4-4m4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 18h14"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
