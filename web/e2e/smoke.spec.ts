import { expect, test } from '@playwright/test'

// Needs no server and no API key: the ready-made rooms are bundled with the site.
test('front page, a ready-made room, and the Layout panel', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/')
  await expect(page.getByText('Your room is the level.')).toBeVisible()
  await expect(page.getByText('Your space, understood.')).toBeVisible()

  await page.getByText('Open the example room', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Studio apartment (real scan)' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('2 objects found')).toBeVisible()
  await expect(page.locator('canvas').first()).toBeVisible()

  await page.getByText('Layout', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Change the layout' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Layout agent' })).toBeVisible()

  expect(errors).toEqual([])
})
