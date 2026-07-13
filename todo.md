~~sync video speed with host (beyond youtube's speed control)~~

reattach to new tab -- otherwise better tab handeling //NOT FORMALIZED - DON'T IMPLEMENT

smoothening sync

Transmit video url with time for faster initial sync 

wierd continuous repeat redirection bug

arc bug where all youtube tabs get synced

activate by hotkey shortcut

autoplay handeling - turn it on/off as appropriate

work on phone/google play?

"switch here" option to switch currently synced tab for both host and follower (different behaviour)

webrtcRAW + consistent polling at 100ms instead of demand-based

apply sync only in 5 second gaps, with exponential decay to 30 seconds

make the server authenticated or easy to turn on/off

pause followers untill host has loaded (after url change)

add host follower toggle to actual website?

opt-in features?

extension prevents website from loading properly

progromatically run commands on dashboard website?

setup and provision lxc/vm on proxmox by script?

sync queue at least one way?

each recieved host status should only be applied once unless follower had paused/buffered

number of listeners

random repeated pausing bug for follower

prevent the server from storing the last broadcasted host data

label button synchronize and desynchronize

generate and share room code

configurable delay?

desktop notifications?

rather than set regular intervals, follower should sync as accurately as possible while taking into account it's own signal stability to make sure the video is not allowed to jitter.

decrease the role of the server

when no host - take to parking or pause and detach until host is registered


for me: redirect poped out videos to elsewhere (streaming to other screens)

only take context of a tab when popup is clicked

normal websites get redirected bug - once a tab is syncing, no other tab should be able to attach, or run content.js

~~better youtube shorts handeling~~

~~better youtube ad handeling~~

~~support syncing non-youtube video websites (not specifically, rather when the extension is clicked - with seperate youtube specific logics being retained)~~

~~speedtest against server, check system specs and downgrade to youtube to 720p more aggressively~~ 

~~fix syncing follower got stuck on URL change bug~~

~~follower doesn't follow youtube miniplayer element if the host is using keyboard shortcuts to rapidly or otherwise as well - basically if the miniplayer is playing on host at all, it should sync that as full video to followers.~~

~~add video pop out functionality for all supportable websites - add context menu action to support pop out of any supportable video elements - especially for gmeet - and use right click location based selection to overcome transparent overlays above video elements~~

~~reopen extension popup when tab is switched to the correct synced tab~~

~~implement modularity and clean directory and content sturcture in extension code.~~
