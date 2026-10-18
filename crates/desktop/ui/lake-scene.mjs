// A decorative scene with one real control: the sun / moon switches day and night.
// Its glow still follows the live shell's speaking / speech-off-state classes, so
// no independent audio state is invented.
export function lakeSceneMarkup() {
  const waves = Array.from({ length: 148 }, (_, index) => {
    const curve = Math.abs(Math.sin(index * 0.29) * Math.cos(index * 0.083)) * 0.75
      + Math.abs(Math.sin(index * 1.3)) * 0.25;
    const height = Math.round(8 + curve * 50);
    const delay = (-(index * 0.137) % 1.2).toFixed(2);
    const duration = (0.9 + (index % 5) * 0.12).toFixed(2);
    return `<i class="lake-wave" style="--wave-height:${height}px;--wave-delay:${delay}s;--wave-duration:${duration}s"></i>`;
  }).join('');
  const bird = '<svg viewBox="0 0 18 8" aria-hidden="true"><path d="M1 6 Q5 1 9 6 Q13 1 17 6"/></svg>';
  return `<svg class="lake-filters" aria-hidden="true"><defs><filter id="lake-caption-ripple" x="-4%" y="-8%" width="108%" height="116%"><feTurbulence type="fractalNoise" baseFrequency="0.006 0.1" numOctaves="1" seed="4" result="water"><animate attributeName="baseFrequency" dur="10s" values="0.006 0.1;0.008 0.13;0.006 0.1" repeatCount="indefinite"></animate></feTurbulence><feDisplacementMap in="SourceGraphic" in2="water" scale="8" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap></filter><filter id="lake-peek-ripple"><feTurbulence type="fractalNoise" baseFrequency="0.006 0.1" numOctaves="1" seed="4" result="water"></feTurbulence><feDisplacementMap in="SourceGraphic" in2="water" scale="3" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap></filter></defs></svg><div class="lake-scenery" aria-hidden="true">
    <div class="lake-sky"></div><div class="lake-stars"></div><span class="lake-shooting-star"></span>
    <span class="lake-cloud cloud-one"></span><span class="lake-cloud cloud-two"></span><span class="lake-cloud cloud-three"></span>
    <div class="lake-mist mist-one"></div>
    <span class="lake-bird bird-one">${bird}</span><span class="lake-bird bird-two">${bird}</span><span class="lake-bird bird-three">${bird}</span>
    <div class="lake-ridge ridge-far"></div><div class="lake-ridge ridge-near"></div><div class="lake-haze"></div>
    <div class="lake-mist mist-two"></div>
    <div class="lake-horizon"></div><div class="lake-water"></div><div class="lake-reflection"></div>
    <span class="lake-ripple ripple-one"></span><span class="lake-ripple ripple-two"></span><span class="lake-ripple ripple-three"></span>
    <div class="lake-waves">${waves}</div><div class="lake-deep-rays"><i></i><i></i><i></i></div>
  </div><button type="button" id="lake-orb" class="lake-orb" data-action="theme.toggle" aria-label="切换深浅色"></button><span class="lake-orb-tip" aria-hidden="true"></span>`;
}
