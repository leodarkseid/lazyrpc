class RPC {
    constructor() {
        this.isDestroyed = false;
        const weakThis = new WeakRef(this);
        // Arrow function binds `this`
        this.timer = setTimeout(() => {
            const instance = weakThis.deref();
            if (instance) console.log("Instance still alive!");
        }, 1000);
    }
}
let weak;
(() => {
    weak = new WeakRef(new RPC());
})();
gc();
setTimeout(() => {
    gc();
    console.log("Arrow func leak:", weak.deref() !== undefined);
}, 100);
