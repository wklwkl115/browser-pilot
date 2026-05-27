window.provenanceHelper = {
  makePayload(seed) {
    const token = `${seed}-provenance-token`;
    return {
      ok: true,
      branch: 'helper-script',
      tokenLength: token.length,
      token,
      sourceTag: 'provenance-helper.js'
    };
  }
};
