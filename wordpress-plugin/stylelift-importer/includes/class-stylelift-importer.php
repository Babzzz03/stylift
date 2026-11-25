<?php
/**
 * REST endpoints the StyleLift extension calls:
 *   GET  /wp-json/stylelift/v1/status  — connection check (who am I, is Elementor active)
 *   POST /wp-json/stylelift/v1/import  — create an Elementor template or page
 *
 * Authentication is WordPress's own: Application Passwords (Users → Profile) sent as
 * HTTP Basic auth by the extension, or a logged-in session with a REST nonce.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class StyleLift_Importer {

	const NS             = 'stylelift/v1';
	const MAX_BODY_BYTES = 12000000; // ~12 MB of JSON
	const MAX_SIDELOAD   = 60;       // images copied into the Media Library per import

	public static function register_routes() {
		register_rest_route(
			self::NS,
			'/status',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'status' ),
				'permission_callback' => array( __CLASS__, 'can_import' ),
			)
		);
		register_rest_route(
			self::NS,
			'/import',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'import' ),
				'permission_callback' => array( __CLASS__, 'can_import' ),
			)
		);
	}

	/** Any author-level user may connect; what they may import is checked per request. */
	public static function can_import() {
		if ( ! is_user_logged_in() ) {
			return new WP_Error( 'stylelift_auth', 'Sign in with an Application Password (Users → Profile → Application Passwords).', array( 'status' => 401 ) );
		}
		return current_user_can( 'edit_posts' );
	}

	public static function status() {
		$user = wp_get_current_user();
		return array(
			'ok'                => true,
			'plugin_version'    => STYLELIFT_IMPORTER_VERSION,
			'site'              => get_bloginfo( 'name' ),
			'user'              => $user->user_login,
			'elementor_active'  => self::elementor_active(),
			'elementor_version' => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : null,
			'can_import_html'   => current_user_can( 'unfiltered_html' ),
			'can_create_pages'  => current_user_can( 'publish_pages' ) || current_user_can( 'edit_pages' ),
		);
	}

	/**
	 * Body (JSON):
	 *   title          string
	 *   target         "template" | "page"           (default "template")
	 *   template_type  "section" | "page" | "container" (Elementor library type, default "section")
	 *   content        Elementor element tree (array)
	 *   page_settings  object (optional)
	 *   source_url     string (optional, kept as post meta)
	 *   sideload       bool   (copy images into the Media Library, default true)
	 */
	public static function import( WP_REST_Request $request ) {
		$raw = $request->get_body();
		if ( strlen( (string) $raw ) > self::MAX_BODY_BYTES ) {
			return new WP_Error( 'stylelift_size', 'The import is larger than 12 MB. Send fewer sections at a time.', array( 'status' => 413 ) );
		}
		$body = $request->get_json_params();
		if ( ! is_array( $body ) ) {
			return new WP_Error( 'stylelift_json', 'The request body is not valid JSON.', array( 'status' => 400 ) );
		}

		// Captured sections are raw HTML: the same rule WordPress applies to its editors.
		if ( ! current_user_can( 'unfiltered_html' ) ) {
			return new WP_Error( 'stylelift_unfiltered', 'Your WordPress role may not save raw HTML (the unfiltered_html capability). Use an Administrator or Editor account.', array( 'status' => 403 ) );
		}

		$target = isset( $body['target'] ) && 'page' === $body['target'] ? 'page' : 'template';
		if ( 'page' === $target && ! current_user_can( 'edit_pages' ) ) {
			return new WP_Error( 'stylelift_pages', 'Your WordPress role may not create pages.', array( 'status' => 403 ) );
		}
		$tpl_type = isset( $body['template_type'] ) && in_array( $body['template_type'], array( 'section', 'page', 'container' ), true ) ? $body['template_type'] : 'section';
		$title    = sanitize_text_field( isset( $body['title'] ) ? (string) $body['title'] : '' );
		if ( '' === $title ) {
			$title = 'Imported section';
		}

		$content = StyleLift_Sanitizer::clean_elements( isset( $body['content'] ) ? $body['content'] : null );
		if ( is_wp_error( $content ) ) {
			return $content;
		}
		$page_settings = isset( $body['page_settings'] ) && is_array( $body['page_settings'] ) ? $body['page_settings'] : array();

		$post_id = wp_insert_post(
			array(
				'post_type'   => 'page' === $target ? 'page' : 'elementor_library',
				'post_status' => 'page' === $target ? 'draft' : 'publish',
				'post_title'  => $title,
			),
			true
		);
		if ( is_wp_error( $post_id ) ) {
			return $post_id;
		}

		$images = array();
		if ( ! isset( $body['sideload'] ) || $body['sideload'] ) {
			$images  = self::sideload_images( $content, $post_id );
			$content = self::replace_urls( $content, $images );
		}

		update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
		update_post_meta( $post_id, '_elementor_version', defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : '3.20.0' );
		update_post_meta( $post_id, '_elementor_data', wp_slash( wp_json_encode( $content ) ) );
		if ( $page_settings ) {
			update_post_meta( $post_id, '_elementor_page_settings', $page_settings );
		}
		if ( ! empty( $body['source_url'] ) ) {
			update_post_meta( $post_id, '_stylelift_source_url', esc_url_raw( (string) $body['source_url'] ) );
		}
		if ( 'page' === $target ) {
			// full width, no theme title: the captured page brings its own header and layout
			update_post_meta( $post_id, '_wp_page_template', 'elementor_header_footer' );
		} else {
			update_post_meta( $post_id, '_elementor_template_type', $tpl_type );
			if ( taxonomy_exists( 'elementor_library_type' ) ) {
				wp_set_object_terms( $post_id, $tpl_type, 'elementor_library_type' );
			}
		}
		self::clear_elementor_cache( $post_id );

		return array(
			'id'               => $post_id,
			'target'           => $target,
			'edit_url'         => admin_url( 'post.php?post=' . $post_id . '&action=elementor' ),
			'view_url'         => get_permalink( $post_id ),
			'images_imported'  => count( array_filter( $images ) ),
			'elementor_active' => self::elementor_active(),
		);
	}

	public static function elementor_active() {
		return did_action( 'elementor/loaded' ) > 0 || class_exists( '\Elementor\Plugin' );
	}

	private static function clear_elementor_cache( $post_id ) {
		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
		}
		delete_post_meta( $post_id, '_elementor_css' );
	}

	/** Every http(s) image URL in the widgets' markup: <img src/srcset>, url(...) in CSS. */
	public static function find_image_urls( array $elements ) {
		$found = array();
		$walk  = function ( $value ) use ( &$walk, &$found ) {
			if ( is_array( $value ) ) {
				foreach ( $value as $v ) {
					$walk( $v );
				}
				return;
			}
			if ( ! is_string( $value ) || false === strpos( $value, 'http' ) ) {
				return;
			}
			if ( preg_match_all( '#\bsrc\s*=\s*["\'](https?://[^"\'\s>]+)#i', $value, $m ) ) {
				foreach ( $m[1] as $u ) {
					$found[ html_entity_decode( $u ) ] = true;
				}
			}
			if ( preg_match_all( '#\bsrcset\s*=\s*["\']([^"\']+)#i', $value, $m ) ) {
				foreach ( $m[1] as $set ) {
					foreach ( preg_split( '/,\s+/', $set ) as $part ) {
						$u = preg_split( '/\s+/', trim( $part ) )[0];
						if ( preg_match( '#^https?://#', $u ) ) {
							$found[ html_entity_decode( $u ) ] = true;
						}
					}
				}
			}
			if ( preg_match_all( '#url\(\s*["\']?(https?://[^"\'\)\s]+)#i', $value, $m ) ) {
				foreach ( $m[1] as $u ) {
					$found[ html_entity_decode( $u ) ] = true;
				}
			}
		};
		$walk( $elements );
		// images only: by extension, or image CDNs that serve without one
		return array_values(
			array_filter(
				array_keys( $found ),
				function ( $u ) {
					$path = strtolower( (string) wp_parse_url( $u, PHP_URL_PATH ) );
					return (bool) preg_match( '/\.(png|jpe?g|gif|webp|avif|svg)$/', $path ) || false !== strpos( $u, '/images/' ) || false !== strpos( $u, 'image?' );
				}
			)
		);
	}

	/** Copy images into the Media Library. Returns original URL → local URL (false if it failed). */
	private static function sideload_images( array $elements, $post_id ) {
		$urls = array_slice( self::find_image_urls( $elements ), 0, self::MAX_SIDELOAD );
		if ( ! $urls ) {
			return array();
		}
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$map = array();
		foreach ( $urls as $url ) {
			$tmp = download_url( $url, 20 );
			if ( is_wp_error( $tmp ) ) {
				$map[ $url ] = false;
				continue;
			}
			$name = basename( (string) wp_parse_url( $url, PHP_URL_PATH ) );
			if ( ! preg_match( '/\.(png|jpe?g|gif|webp|avif|svg)$/i', $name ) ) {
				$type = wp_check_filetype_and_ext( $tmp, $name );
				$ext  = ! empty( $type['ext'] ) ? $type['ext'] : 'jpg';
				$name = sanitize_file_name( ( $name ? $name : 'image' ) . '.' . $ext );
			}
			$id = media_handle_sideload( array( 'name' => $name, 'tmp_name' => $tmp ), $post_id );
			if ( is_wp_error( $id ) ) {
				@unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
				$map[ $url ] = false;
				continue;
			}
			$map[ $url ] = wp_get_attachment_url( $id );
		}
		return $map;
	}

	/** Point the markup at the Media Library copies. */
	public static function replace_urls( array $elements, array $map ) {
		$map = array_filter( $map );
		if ( ! $map ) {
			return $elements;
		}
		// longest first, so a URL never replaces part of a longer one
		uksort( $map, function ( $a, $b ) { return strlen( $b ) - strlen( $a ); } );
		$from = array();
		$to   = array();
		foreach ( $map as $orig => $local ) {
			$from[] = $orig;
			$to[]   = $local;
			$enc    = esc_attr( $orig ); // & → &amp; as it appears inside attributes
			if ( $enc !== $orig ) {
				$from[] = $enc;
				$to[]   = $local;
			}
		}
		$walk = function ( $value ) use ( &$walk, $from, $to ) {
			if ( is_array( $value ) ) {
				foreach ( $value as $k => $v ) {
					$value[ $k ] = $walk( $v );
				}
				return $value;
			}
			return is_string( $value ) ? str_replace( $from, $to, $value ) : $value;
		};
		return $walk( $elements );
	}
}
