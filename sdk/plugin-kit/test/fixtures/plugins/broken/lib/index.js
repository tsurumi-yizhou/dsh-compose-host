export const name = 'broken-demo'
export const inject = ['dshCompose']
export function apply(ctx) {
  ctx.inject(['dshCompose?'], (ctx) => {
    ctx.dshCompose.on('a', () => ({ insert: 'x' }))
  })
}
