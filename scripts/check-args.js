// Verify how youtube-dl-exec turns option objects into CLI flags, and confirm
// the bundled binary path we can spawn directly for streaming.
const youtubedl = require('youtube-dl-exec');

console.log('YOUTUBE_DL_PATH:', youtubedl.constants.YOUTUBE_DL_PATH);

console.log('args(dumpJson):', JSON.stringify(youtubedl.args({ dumpJson: true })));
console.log('args(output dash):', JSON.stringify(youtubedl.args({ output: '-' })));
console.log('args(format):', JSON.stringify(youtubedl.args({ format: '140' })));
console.log('args(noPlaylist):', JSON.stringify(youtubedl.args({ noPlaylist: true })));
console.log('args(quiet):', JSON.stringify(youtubedl.args({ quiet: true })));
console.log('args(noWarnings):', JSON.stringify(youtubedl.args({ noWarnings: true })));
console.log('args(restrictFilenames):', JSON.stringify(youtubedl.args({ restrictFilenames: true })));
