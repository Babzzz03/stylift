<?php
/**
 * Tools → StyleLift Importer: how to connect the extension, and what this site supports.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class StyleLift_Admin {

	public static function register_page() {
		add_management_page( 'StyleLift Importer', 'StyleLift Importer', 'edit_posts', 'stylelift-importer', array( __CLASS__, 'render' ) );
	}

	public static function render() {
		$endpoint   = rest_url( StyleLift_Importer::NS . '/import' );
		$profile    = admin_url( 'profile.php#application-passwords-section' );
		$app_pw_ok  = function_exists( 'wp_is_application_passwords_available' ) && wp_is_application_passwords_available();
		$elementor  = StyleLift_Importer::elementor_active();
		$can_html   = current_user_can( 'unfiltered_html' );
		$recent     = get_posts(
			array(
				'post_type'      => array( 'elementor_library', 'page' ),
				'meta_key'       => '_stylelift_source_url', // phpcs:ignore WordPress.DB.SlowDBQuery
				'posts_per_page' => 10,
				'post_status'    => 'any',
			)
		);
		?>
		<div class="wrap">
			<h1>StyleLift Importer</h1>
			<p>Send sections from any live website to this site with the StyleLift browser extension. Each import becomes an Elementor template (Templates → Saved Templates) or a draft page you can edit in Elementor.</p>

			<h2>Connect the extension</h2>
			<ol>
				<li>Open <a href="<?php echo esc_url( $profile ); ?>">your profile → Application Passwords</a>, type a name such as “StyleLift”, and click <strong>Add New Application Password</strong>.</li>
				<li>In the extension, open <strong>Settings → WordPress</strong> and enter:
					<ul>
						<li>Site address: <code><?php echo esc_html( home_url() ); ?></code></li>
						<li>Username: <code><?php echo esc_html( wp_get_current_user()->user_login ); ?></code></li>
						<li>Application password: the one you just created</li>
					</ul>
				</li>
				<li>Click <strong>Test connection</strong> in the extension.</li>
			</ol>

			<h2>This site</h2>
			<table class="widefat striped" style="max-width:720px">
				<tbody>
					<tr><td>Application Passwords</td><td><?php echo $app_pw_ok ? 'Available' : 'Unavailable — they need HTTPS, or a local site (WP_ENVIRONMENT_TYPE = local)'; ?></td></tr>
					<tr><td>Elementor</td><td><?php echo $elementor ? 'Active' : 'Not active — imports are stored and open in Elementor once it is activated'; ?></td></tr>
					<tr><td>Your account may import raw HTML</td><td><?php echo $can_html ? 'Yes' : 'No — use an Administrator or Editor account'; ?></td></tr>
					<tr><td>Endpoint</td><td><code><?php echo esc_html( $endpoint ); ?></code></td></tr>
				</tbody>
			</table>

			<?php if ( $recent ) : ?>
				<h2>Recent imports</h2>
				<table class="widefat striped" style="max-width:720px">
					<thead><tr><th>Title</th><th>Type</th><th>From</th><th></th></tr></thead>
					<tbody>
					<?php foreach ( $recent as $p ) : ?>
						<tr>
							<td><?php echo esc_html( get_the_title( $p ) ); ?></td>
							<td><?php echo 'page' === $p->post_type ? 'Page' : 'Template'; ?></td>
							<td><?php echo esc_html( (string) wp_parse_url( (string) get_post_meta( $p->ID, '_stylelift_source_url', true ), PHP_URL_HOST ) ); ?></td>
							<td><a href="<?php echo esc_url( admin_url( 'post.php?post=' . $p->ID . '&action=elementor' ) ); ?>">Edit with Elementor</a></td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>
		<?php
	}
}
