// Shared demo sign-in for the browser suites. On slow CI runners the form can lose typed values while the page settles,
// and the browser then blocks the submit without sending a request, so verify the values and retry instead of waiting.
export async function signInDemo(page, base, demo) {
  let last = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(base + '/login', { waitUntil: 'networkidle' }).catch(() => {})
    const email = page.locator('input[type="email"]'), pw = page.locator('input[type="password"]')
    await email.fill(demo.email); await pw.fill(demo.password)
    if (await email.inputValue() !== demo.email || await pw.inputValue() !== demo.password) { last = 'fields were cleared before submit'; continue }
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    try { await page.waitForURL('**/home', { timeout: 20000 }); return } catch { last = `no redirect from ${page.url()}` }
  }
  throw new Error(`demo sign-in failed after 4 attempts: ${last}`)
}
