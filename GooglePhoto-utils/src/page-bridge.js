(() => {
  "use strict";

  window.addEventListener("gpu-request-google-photos-globals", () => {
    const data = window.WIZ_global_data || {};
    window.dispatchEvent(new CustomEvent("gpu-response-google-photos-globals", {
      detail: {
        rapt: data.Dbw5Ud || null,
        account: data.oPEP7c || null,
        fSid: data.FdrFJe || null,
        bl: data.cfb2h || null,
        path: data.eptZe || null,
        at: data.SNlM0e || null
      }
    }));
  });
})();
