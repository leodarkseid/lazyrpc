class RPC {
    constructor() {
        this.isDestroyed = false;
        this.ttl = 10;
        this.test = (async () => {
            console.log(this.ttl);
            const weakThis = new WeakRef(this);
            this.timer = setTimeout(() => {
                const instance = weakThis.deref();
                if (instance) console.log("Instance still alive!");
            }, 1000);
        })();
    }
}
let weak;
(() => {
    weak = new WeakRef(new RPC());
})();
setTimeout(() => {
    global.gc();
    console.log("Arrow func leak (shared context):", weak.deref() !== undefined);
}, 100);
