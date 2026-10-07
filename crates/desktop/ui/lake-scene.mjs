// A decorative scene with one real control. Its animations follow the live shell's
// speaking / speech-off-state classes, so no independent audio state is invented.
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
  return `<div class="lake-scenery" aria-hidden="true">
    <div class="lake-sky"></div><div class="lake-stars"></div><span class="lake-shooting-star"></span>
    <span class="lake-cloud cloud-one"></span><span class="lake-cloud cloud-two"></span><span class="lake-cloud cloud-three"></span>
    <div class="lake-mist mist-one"></div>
    <span class="lake-bird bird-one">${bird}</span><span class="lake-bird bird-two">${bird}</span><span class="lake-bird bird-three">${bird}</span>
    <div class="lake-ridge ridge-far"></div><div class="lake-ridge ridge-near"></div><div class="lake-haze"></div>
    <div class="lake-mist mist-two"></div>
    <div class="lake-horizon"></div><div class="lake-water"></div><div class="lake-reflection"></div>
    <span class="lake-ripple ripple-one"></span><span class="lake-ripple ripple-two"></span><span class="lake-ripple ripple-three"></span>
    <div class="lake-waves">${waves}</div>
  </div><button type="button" id="lake-orb" class="lake-orb" data-action="volume.toggle" aria-label="调整播报音量" aria-haspopup="dialog" aria-controls="tts-menu" aria-expanded="false"></button><span class="lake-orb-tip" aria-hidden="true">声音 · volume</span>`;
}
